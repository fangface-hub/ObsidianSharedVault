import { Notice, Plugin, TFile, normalizePath } from "obsidian";
import {
    DAY_IN_MS,
    DEFAULT_SETTINGS,
    LEGACY_NODE_REGISTRY_DIR,
    LEGACY_OPERATION_CACHE_DIR,
    LEGACY_SNAPSHOT_DIR,
    SHARED_VAULT_STORAGE_RELATIVE_DIR
} from "./shared-vault-config";
import { SharedVaultEngine } from "./shared-vault-engine";
import { SharedVaultNodeRegistryModal } from "./shared-vault-modals";
import { SharedVaultSettingTab } from "./shared-vault-settings-tab";
import type { NodeListEntry, NodeRegistryEntry, OperationFile, SharedVaultData, SharedVaultSettings } from "./shared-vault-types";
import { hashText, safeMkdir } from "./shared-vault-utils";

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
      autoSyncIntervalSec: this.data.autoSyncIntervalSec,
      cacheTtlDays: this.data.cacheTtlDays,
      operationCacheDir: this.data.operationCacheDir,
      snapshotDir: this.data.snapshotDir
    };

    await this.migrateLegacySharedStorage();
    await this.migrateLegacyUserScopedCache();

    this.engine = this.createEngine();

    await this.engine.initialize();
    await this.evictExpiredNodes();
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
    this.data = {
      ...this.data,
      ...this.settings
    };
    await this.saveLocalPluginData(this.data);
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
    const localRaw = await this.loadLocalPluginData();
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
      autoSyncIntervalSec: raw?.autoSyncIntervalSec ?? DEFAULT_SETTINGS.autoSyncIntervalSec,
      cacheTtlDays: raw?.cacheTtlDays ?? DEFAULT_SETTINGS.cacheTtlDays,
      operationCacheDir: this.resolveSharedStoragePath(raw?.operationCacheDir, this.getOperationCacheDir(), LEGACY_OPERATION_CACHE_DIR),
      snapshotDir: this.resolveSharedStoragePath(raw?.snapshotDir, this.getSnapshotDir(), LEGACY_SNAPSHOT_DIR)
    };

    if (!localRaw) {
      await this.saveLocalPluginData(data);
    }

    return data;
  }

  private async loadLocalPluginData(): Promise<Partial<SharedVaultData> | null> {
    const path = this.getLocalDataPath();
    if (!(await this.app.vault.adapter.exists(path))) {
      return null;
    }

    try {
      const raw = await this.app.vault.adapter.read(path);
      return JSON.parse(raw) as Partial<SharedVaultData>;
    } catch {
      return null;
    }
  }

  private async saveLocalPluginData(data: SharedVaultData): Promise<void> {
    await safeMkdir(this, this.getLocalDataDir());
    await this.app.vault.adapter.write(this.getLocalDataPath(), JSON.stringify(data, null, 2));
  }

  private getLocalDataDir(): string {
    return normalizePath(`${this.app.vault.configDir}/cache/${this.vaultId}`);
  }

  private getLocalDataPath(): string {
    return normalizePath(`${this.getLocalDataDir()}/local-plugin-data.json`);
  }

  private getSharedVaultStorageDir(): string {
    return normalizePath(`${this.app.vault.configDir}/${SHARED_VAULT_STORAGE_RELATIVE_DIR}`);
  }

  private getOperationCacheDir(): string {
    return normalizePath(`${this.getSharedVaultStorageDir()}/operation-cache`);
  }

  private getSnapshotDir(): string {
    return normalizePath(`${this.getSharedVaultStorageDir()}/snapshots`);
  }

  private getNodeRegistryDir(): string {
    return normalizePath(`${this.getSharedVaultStorageDir()}/node-registry`);
  }

  private resolveSharedStoragePath(rawPath: string | undefined, defaultPath: string, legacyDefaultPath: string): string {
    const value = rawPath?.trim();
    if (!value) {
      return defaultPath;
    }

    const normalized = normalizePath(value);
    return normalized === legacyDefaultPath ? defaultPath : normalized;
  }

  private async migrateLegacySharedStorage(): Promise<void> {
    await this.migrateLegacySharedDir(LEGACY_NODE_REGISTRY_DIR, this.getNodeRegistryDir());
    await this.migrateLegacySharedDir(LEGACY_OPERATION_CACHE_DIR, this.settings.operationCacheDir);
    await this.migrateLegacySharedDir(LEGACY_SNAPSHOT_DIR, this.settings.snapshotDir);
  }

  private async migrateLegacySharedDir(oldPath: string, newPath: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(oldPath))) {
      return;
    }

    if (await adapter.exists(newPath)) {
      return;
    }

    await safeMkdir(this, this.getParentDir(newPath));
    await adapter.rename(oldPath, newPath);
  }

  private getParentDir(path: string): string {
    const normalized = normalizePath(path);
    const index = normalized.lastIndexOf("/");
    return index > 0 ? normalized.slice(0, index) : this.app.vault.configDir;
  }

  private createEngine(): SharedVaultEngine {
    return new SharedVaultEngine(
      this,
      this.vaultId,
      this.data.nodeId,
      this.settings.operationCacheDir,
      this.settings.snapshotDir
    );
  }

  private async migrateLegacyUserScopedCache(): Promise<void> {
    const adapter = this.app.vault.adapter;
    const nodeCacheRoot = SharedVaultEngine.getNodeCacheRoot(this, this.vaultId, this.data.nodeId);
    if (!(await adapter.exists(nodeCacheRoot))) {
      return;
    }

    const modernStatePath = normalizePath(`${nodeCacheRoot}/state.json`);
    const modernDocRoot = normalizePath(`${nodeCacheRoot}/docs`);
    if (await adapter.exists(modernStatePath) || await adapter.exists(modernDocRoot)) {
      return;
    }

    const listed = await adapter.list(nodeCacheRoot);
    const legacyRoots = listed.folders.sort();

    for (const legacyRoot of legacyRoots) {
      const legacyStatePath = normalizePath(`${legacyRoot}/state.json`);
      const legacyDocRoot = normalizePath(`${legacyRoot}/docs`);
      const hasLegacyState = await adapter.exists(legacyStatePath);
      const hasLegacyDocs = await adapter.exists(legacyDocRoot);

      if (!hasLegacyState && !hasLegacyDocs) {
        continue;
      }

      if (hasLegacyState && !(await adapter.exists(modernStatePath))) {
        await adapter.rename(legacyStatePath, modernStatePath);
      }

      if (hasLegacyDocs && !(await adapter.exists(modernDocRoot))) {
        await adapter.rename(legacyDocRoot, modernDocRoot);
      }

      const rest = await adapter.list(legacyRoot);
      if (rest.files.length === 0 && rest.folders.length === 0) {
        await adapter.rmdir(legacyRoot, false);
      }

      return;
    }
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
    await safeMkdir(this, this.getNodeRegistryDir());
  }

  private async evictExpiredNodes(): Promise<void> {
    const ttlMs = this.settings.cacheTtlDays * DAY_IN_MS;
    if (ttlMs <= 0) {
      return;
    }

    const nodeRegistryDir = this.getNodeRegistryDir();
    if (!(await this.app.vault.adapter.exists(nodeRegistryDir))) {
      return;
    }

    const listed = await this.app.vault.adapter.list(nodeRegistryDir);
    const now = Date.now();

    for (const path of listed.files.filter((filePath) => filePath.endsWith(".json"))) {
      const raw = await this.app.vault.adapter.read(path);
      const entry = JSON.parse(raw) as NodeRegistryEntry;

      if (now - entry.lastSeen <= ttlMs) {
        continue;
      }

      await this.app.vault.adapter.remove(path);

      if (entry.nodeId === this.data.nodeId) {
        await this.removeNodeCache(entry.nodeId);
      }
    }
  }

  private async registerCurrentNode(patch: Partial<NodeRegistryEntry> = {}): Promise<void> {
    const existingEntry = await this.readCurrentNodeRegistryEntry();
    const defaultEntry: NodeRegistryEntry = {
      nodeId: this.data.nodeId,
      vaultId: this.vaultId,
      lastSeen: Date.now()
    };

    const entry: NodeRegistryEntry = {
      ...defaultEntry,
      ...existingEntry,
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
    return normalizePath(`${this.getNodeRegistryDir()}/${nodeId}.json`);
  }

  private async removeNodeCache(nodeId: string): Promise<void> {
    const cacheRoot = SharedVaultEngine.getCacheRoot(this, this.vaultId, nodeId);
    if (!(await this.app.vault.adapter.exists(cacheRoot))) {
      return;
    }

    await this.app.vault.adapter.rmdir(cacheRoot, true);
  }

  private async showNodeRegistryModal(): Promise<void> {
    const entries = await this.listNodeRegistryEntries();
    const modal = new SharedVaultNodeRegistryModal(this, entries, this.settings.cacheTtlDays);
    modal.open();
  }

  private async listNodeRegistryEntries(): Promise<NodeListEntry[]> {
    const nodeRegistryDir = this.getNodeRegistryDir();
    if (!(await this.app.vault.adapter.exists(nodeRegistryDir))) {
      return [];
    }

    const listed = await this.app.vault.adapter.list(nodeRegistryDir);
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
    if (!(await this.app.vault.adapter.exists(this.settings.operationCacheDir))) {
      return;
    }

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
