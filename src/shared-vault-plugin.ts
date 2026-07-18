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
import type { CacheState, CachedDocument, NodeListEntry, NodeRegistryEntry, OperationFile, SharedVaultData, SharedVaultSettings } from "./shared-vault-types";
import { base64ToText, hashText, safeMkdir } from "./shared-vault-utils";

interface LegacyCacheCandidate {
  root: string;
  statePath: string;
  docRoot: string;
  hasState: boolean;
  hasDocs: boolean;
  processedCount: number;
  docCount: number;
  alignedDocCount: number;
}

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
    const listed = await adapter.list(nodeCacheRoot);
    const legacyCandidates = await this.readLegacyCacheCandidates(listed.folders.sort());
    if (legacyCandidates.length === 0) {
      return;
    }

    const hasModernState = await adapter.exists(modernStatePath);
    const hasModernDocs = await adapter.exists(modernDocRoot);
    const modernCandidate = await this.inspectCacheCandidate(nodeCacheRoot);
    const selectedLegacy = this.selectPreferredCacheCandidate(legacyCandidates);

    const shouldRecoverModernCache = (hasModernState || hasModernDocs)
      && modernCandidate.alignedDocCount === 0
      && selectedLegacy.alignedDocCount > 0;

    if (!shouldRecoverModernCache && (hasModernState || hasModernDocs)) {
      return;
    }

    if (selectedLegacy.hasDocs) {
      if (hasModernDocs) {
        await adapter.rmdir(modernDocRoot, true);
      }

      await adapter.rename(selectedLegacy.docRoot, modernDocRoot);
    }

    const mergedState = await this.mergeProcessedState([
      ...(hasModernState ? [modernCandidate] : []),
      ...legacyCandidates
    ]);

    if (mergedState.processedOpIds.length > 0) {
      await adapter.write(modernStatePath, JSON.stringify(mergedState, null, 2));
    }

    if (selectedLegacy.hasState && await adapter.exists(selectedLegacy.statePath)) {
      await adapter.remove(selectedLegacy.statePath);
    }

    for (const candidate of legacyCandidates) {
      const rest = await adapter.list(candidate.root);
      if (rest.files.length === 0 && rest.folders.length === 0) {
        await adapter.rmdir(candidate.root, false);
      }
    }
  }

  private async readLegacyCacheCandidates(roots: string[]): Promise<LegacyCacheCandidate[]> {
    const candidates: LegacyCacheCandidate[] = [];

    for (const root of roots) {
      const candidate = await this.inspectCacheCandidate(root);
      if (!candidate.hasState && !candidate.hasDocs) {
        continue;
      }

      candidates.push(candidate);
    }

    return candidates;
  }

  private async inspectCacheCandidate(root: string): Promise<LegacyCacheCandidate> {
    const adapter = this.app.vault.adapter;
    const statePath = normalizePath(`${root}/state.json`);
    const docRoot = normalizePath(`${root}/docs`);
    const hasState = await adapter.exists(statePath);
    const hasDocs = await adapter.exists(docRoot);

    let processedCount = 0;
    if (hasState) {
      const raw = await adapter.read(statePath);
      const state = JSON.parse(raw) as CacheState;
      processedCount = state.processedOpIds.length;
    }

    let docCount = 0;
    let alignedDocCount = 0;
    if (hasDocs) {
      const listed = await adapter.list(docRoot);
      const docPaths = listed.files.filter((path) => path.endsWith(".json")).sort();
      docCount = docPaths.length;

      for (const path of docPaths) {
        const raw = await adapter.read(path);
        const document = JSON.parse(raw) as CachedDocument;
        if (!document.vaultTextBase64) {
          continue;
        }

        const file = this.app.vault.getAbstractFileByPath(document.path);
        if (!(file instanceof TFile)) {
          continue;
        }

        if (base64ToText(document.vaultTextBase64) === await this.app.vault.read(file)) {
          alignedDocCount += 1;
        }
      }
    }

    return {
      root,
      statePath,
      docRoot,
      hasState,
      hasDocs,
      processedCount,
      docCount,
      alignedDocCount
    };
  }

  private selectPreferredCacheCandidate(candidates: LegacyCacheCandidate[]): LegacyCacheCandidate {
    return candidates.slice().sort((left, right) => {
      if (right.alignedDocCount !== left.alignedDocCount) {
        return right.alignedDocCount - left.alignedDocCount;
      }

      if (right.processedCount !== left.processedCount) {
        return right.processedCount - left.processedCount;
      }

      if (right.docCount !== left.docCount) {
        return right.docCount - left.docCount;
      }

      return left.root.localeCompare(right.root);
    })[0];
  }

  private async mergeProcessedState(candidates: LegacyCacheCandidate[]): Promise<CacheState> {
    const processedOpIds = new Set<string>();

    for (const candidate of candidates) {
      if (!candidate.hasState || !(await this.app.vault.adapter.exists(candidate.statePath))) {
        continue;
      }

      const raw = await this.app.vault.adapter.read(candidate.statePath);
      const state = JSON.parse(raw) as CacheState;
      for (const operationId of state.processedOpIds) {
        processedOpIds.add(operationId);
      }
    }

    return {
      processedOpIds: Array.from(processedOpIds).sort().slice(-5000)
    };
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
