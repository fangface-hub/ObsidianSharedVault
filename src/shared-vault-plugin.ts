import { Notice, Plugin, TFile, normalizePath } from "obsidian";
import { DAY_IN_MS, DEFAULT_SETTINGS, NODE_REGISTRY_DIR } from "./shared-vault-config";
import { SharedVaultEngine } from "./shared-vault-engine";
import { SharedVaultNodeRegistryModal } from "./shared-vault-modals";
import { SharedVaultSettingTab } from "./shared-vault-settings-tab";
import type { NodeListEntry, NodeRegistryEntry, OperationFile, SharedVaultData, SharedVaultSettings } from "./shared-vault-types";
import { hashText, safeMkdir } from "./shared-vault-utils";

const LOCAL_DATA_KEY_PREFIX = "shared-vault:data";

export default class SharedVaultPlugin extends Plugin {
  settings: SharedVaultSettings = DEFAULT_SETTINGS;
  data!: SharedVaultData;
  engine!: SharedVaultEngine;
  vaultId = "";

  async onload(): Promise<void> {
    const adapter = this.app.vault.adapter as { getBasePath?: () => string };
    const vaultPath = typeof adapter.getBasePath === "function"
      ? adapter.getBasePath()
      : this.app.vault.getRoot().path;
    this.vaultId = `vault-${(await hashText(vaultPath)).slice(0, 12)}`;

    this.data = await this.loadPluginData();
    this.settings = {
      userId: this.data.userId,
      autoSyncIntervalSec: this.data.autoSyncIntervalSec,
      cacheTtlDays: this.data.cacheTtlDays,
      operationCacheDir: this.data.operationCacheDir,
      snapshotDir: this.data.snapshotDir
    };

    this.engine = this.createEngine(this.settings.userId);

    await this.engine.initialize();
    await this.ensureNodeRegistryDir();
    await this.evictExpiredNodes();
    await this.registerCurrentNode({ lastSeen: Date.now() });
    await this.pruneOperationCache();

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile) {
          void this.handleLocalModify(file);
        }
      })
    );

    this.registerInterval(window.setInterval(() => {
      void this.syncNow(false);
    }, this.settings.autoSyncIntervalSec * 1000));

    this.addCommand({
      id: "sync-now",
      name: "Apply pending shared operations",
      callback: () => {
        void this.syncNow(true);
      }
    });

    this.addCommand({
      id: "rebuild-local-cache",
      name: "Rebuild local crdt cache",
      callback: async () => {
        await this.engine.rebuildLocalCache();
        new Notice("Shared vault local cache rebuilt.");
      }
    });

    this.addCommand({
      id: "create-snapshot",
      name: "Create shared crdt snapshot",
      callback: async () => {
        const snapshotPath = await this.engine.createSnapshot();
        new Notice(`Shared Vault snapshot created: ${snapshotPath}`);
      }
    });

    this.addCommand({
      id: "show-node-registry",
      name: "Show shared node registry",
      callback: async () => {
        await this.showNodeRegistryModal();
      }
    });

    this.addSettingTab(new SharedVaultSettingTab(this.app, this));
  }

  async saveSettings(): Promise<void> {
    const previousUserId = this.data.userId;
    const nextUserId = this.settings.userId.trim() || DEFAULT_SETTINGS.userId;

    this.settings.userId = nextUserId;
    this.data = {
      ...this.data,
      ...this.settings,
      userId: nextUserId
    };
    this.saveLocalPluginData(this.data);

    if (previousUserId !== nextUserId) {
      await this.migrateUserCache(previousUserId, nextUserId);
      this.engine = this.createEngine(nextUserId);
      await this.engine.initialize();
    }
  }

  private async handleLocalModify(file: TFile): Promise<void> {
    await this.prepareNodeParticipation();
    await this.engine.handleLocalModify(file);
  }

  private async syncNow(showNotice: boolean): Promise<void> {
    const result = await this.engine.applyPendingOps();
    await this.updateSyncStateForRegisteredNode(result.lastAppliedOperationId);
    await this.pruneOperationCache();

    if (showNotice) {
      new Notice(result.appliedCount === 0 ? "No shared operations to apply." : `Applied ${result.appliedCount} shared operation file(s).`);
    }
  }

  private async loadPluginData(): Promise<SharedVaultData> {
    const localRaw = this.loadLocalPluginData();
    const sharedRaw = (await this.loadData()) as Partial<SharedVaultData> | null;
    const raw = {
      ...sharedRaw,
      ...localRaw
    };
    const nodeId = localRaw?.nodeId ?? `node-${crypto.randomUUID()}`;

    const data = {
      ...DEFAULT_SETTINGS,
      ...raw,
      nodeId,
      userId: raw?.userId?.trim() || DEFAULT_SETTINGS.userId,
      autoSyncIntervalSec: raw?.autoSyncIntervalSec ?? DEFAULT_SETTINGS.autoSyncIntervalSec,
      cacheTtlDays: raw?.cacheTtlDays ?? DEFAULT_SETTINGS.cacheTtlDays,
      operationCacheDir: raw?.operationCacheDir ?? DEFAULT_SETTINGS.operationCacheDir,
      snapshotDir: raw?.snapshotDir ?? DEFAULT_SETTINGS.snapshotDir
    };

    if (!localRaw) {
      this.saveLocalPluginData(data);
    }

    return data;
  }

  private loadLocalPluginData(): Partial<SharedVaultData> | null {
    const raw = window.localStorage.getItem(this.getLocalDataKey());
    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw) as Partial<SharedVaultData>;
    } catch {
      return null;
    }
  }

  private saveLocalPluginData(data: SharedVaultData): void {
    window.localStorage.setItem(this.getLocalDataKey(), JSON.stringify(data));
  }

  private getLocalDataKey(): string {
    return `${LOCAL_DATA_KEY_PREFIX}:${this.manifest.id}:${this.vaultId}`;
  }

  private createEngine(userId: string): SharedVaultEngine {
    return new SharedVaultEngine(
      this,
      this.vaultId,
      this.data.nodeId,
      userId,
      this.settings.operationCacheDir,
      this.settings.snapshotDir
    );
  }

  private async migrateUserCache(previousUserId: string, nextUserId: string): Promise<void> {
    if (!previousUserId || previousUserId === nextUserId) {
      return;
    }

    const adapter = this.app.vault.adapter;
    const oldCacheRoot = SharedVaultEngine.getCacheRoot(this, this.vaultId, this.data.nodeId, previousUserId);
    const newCacheRoot = SharedVaultEngine.getCacheRoot(this, this.vaultId, this.data.nodeId, nextUserId);

    if (!(await adapter.exists(oldCacheRoot)) || await adapter.exists(newCacheRoot)) {
      return;
    }

    await safeMkdir(this, SharedVaultEngine.getNodeCacheRoot(this, this.vaultId, this.data.nodeId));
    await adapter.rename(oldCacheRoot, newCacheRoot);
    new Notice("Moved local shared cache to the new user ID.");
  }

  private async prepareNodeParticipation(): Promise<void> {
    await this.ensureNodeRegistryDir();
    await this.evictExpiredNodes();
    await this.registerCurrentNode({
      lastSeen: Date.now(),
      lastLocalEditAt: Date.now()
    });
  }

  private async ensureNodeRegistryDir(): Promise<void> {
    await safeMkdir(this, NODE_REGISTRY_DIR);
  }

  private async evictExpiredNodes(): Promise<void> {
    const ttlMs = this.settings.cacheTtlDays * DAY_IN_MS;
    if (ttlMs <= 0) {
      return;
    }

    const listed = await this.app.vault.adapter.list(NODE_REGISTRY_DIR);
    const now = Date.now();

    for (const path of listed.files.filter((filePath) => filePath.endsWith(".json"))) {
      const raw = await this.app.vault.adapter.read(path);
      const entry = JSON.parse(raw) as NodeRegistryEntry;

      if (now - entry.lastSeen <= ttlMs) {
        continue;
      }

      await this.app.vault.adapter.remove(path);

      if (entry.nodeId === this.data.nodeId) {
        await this.removeNodeCache(entry.userId);
      }
    }
  }

  private async registerCurrentNode(patch: Partial<NodeRegistryEntry> = {}): Promise<void> {
    const existingEntry = await this.readCurrentNodeRegistryEntry();
    const defaultEntry: NodeRegistryEntry = {
      nodeId: this.data.nodeId,
      userId: this.settings.userId,
      vaultId: this.vaultId,
      lastSeen: Date.now()
    };

    const entry: NodeRegistryEntry = {
      ...defaultEntry,
      ...existingEntry,
      userId: this.settings.userId,
      ...patch
    };

    await this.app.vault.adapter.write(this.getNodeRegistryPath(this.data.nodeId), JSON.stringify(entry, null, 2));
  }

  private async updateSyncStateForRegisteredNode(lastAppliedOperationId: string | null): Promise<void> {
    const existingEntry = await this.readCurrentNodeRegistryEntry();
    if (!existingEntry) {
      return;
    }

    await this.registerCurrentNode({
      lastSeen: Date.now(),
      lastSyncAt: Date.now(),
      ...(lastAppliedOperationId ? { lastAppliedOperationId } : {})
    });
  }

  private async readCurrentNodeRegistryEntry(): Promise<NodeRegistryEntry | null> {
    const path = this.getNodeRegistryPath(this.data.nodeId);
    if (!(await this.app.vault.adapter.exists(path))) {
      return null;
    }

    const raw = await this.app.vault.adapter.read(path);
    return JSON.parse(raw) as NodeRegistryEntry;
  }

  private getNodeRegistryPath(nodeId: string): string {
    return normalizePath(`${NODE_REGISTRY_DIR}/${nodeId}.json`);
  }

  private async removeNodeCache(userId: string): Promise<void> {
    const cacheRoot = SharedVaultEngine.getCacheRoot(this, this.vaultId, this.data.nodeId, userId);
    if (!(await this.app.vault.adapter.exists(cacheRoot))) {
      return;
    }

    await this.app.vault.adapter.rmdir(cacheRoot, true);
  }

  private async showNodeRegistryModal(): Promise<void> {
    await this.ensureNodeRegistryDir();
    const entries = await this.listNodeRegistryEntries();
    const modal = new SharedVaultNodeRegistryModal(this, entries, this.settings.cacheTtlDays);
    modal.open();
  }

  private async listNodeRegistryEntries(): Promise<NodeListEntry[]> {
    const listed = await this.app.vault.adapter.list(NODE_REGISTRY_DIR);
    const entries: NodeListEntry[] = [];

    for (const path of listed.files.filter((filePath) => filePath.endsWith(".json")).sort()) {
      const raw = await this.app.vault.adapter.read(path);
      const entry = JSON.parse(raw) as NodeRegistryEntry;
      entries.push({
        ...entry,
        registryPath: path
      });
    }

    return entries;
  }

  private async pruneOperationCache(): Promise<void> {
    const listed = await this.app.vault.adapter.list(this.settings.operationCacheDir);
    const activeEntries = (await this.listNodeRegistryEntries()).filter((entry) => this.isActiveNodeEntry(entry));

    if (activeEntries.length === 0) {
      return;
    }

    for (const path of listed.files.filter((filePath) => filePath.endsWith(".json")).sort()) {
      const raw = await this.app.vault.adapter.read(path);
      const operationFile = JSON.parse(raw) as OperationFile;

      if (activeEntries.every((entry) => this.nodeHasProcessedOperation(entry, operationFile))) {
        await this.app.vault.adapter.remove(path);
      }
    }
  }

  private isActiveNodeEntry(entry: NodeRegistryEntry): boolean {
    const ttlMs = this.settings.cacheTtlDays * DAY_IN_MS;
    return entry.vaultId === this.vaultId && (ttlMs <= 0 || Date.now() - entry.lastSeen <= ttlMs);
  }

  private nodeHasProcessedOperation(entry: NodeRegistryEntry, operationFile: OperationFile): boolean {
    if (entry.nodeId === operationFile.node) {
      return true;
    }

    return Boolean(entry.lastAppliedOperationId && entry.lastAppliedOperationId >= operationFile.id);
  }
}
