export interface SharedVaultSettings {
  autoSyncIntervalSec: number;
  cacheTtlDays: number;
  operationCacheDir: string;
  snapshotDir: string;
}

export type SharedVaultSettingKey = keyof SharedVaultSettings;

export interface SharedVaultData extends SharedVaultSettings {
  nodeId: string;
}

export interface CachedDocument {
  path: string;
  stateBase64: string;
  vaultTextBase64?: string;
}

export interface CacheState {
  processedOpIds: string[];
}

export interface YjsOperation {
  type: "yjs-update";
  path: string;
  update: string;
}

export interface OperationFile {
  id: string;
  node: string;
  timestamp: number;
  ops: YjsOperation[];
}

export interface SnapshotFile {
  id: string;
  createdAt: number;
  node: string;
  documents: CachedDocument[];
}

export interface NodeRegistryEntry {
  nodeId: string;
  vaultId: string;
  lastSeen: number;
  lastLocalEditAt?: number;
  lastSyncAt?: number;
  lastAppliedOperationId?: string;
}

export interface NodeListEntry extends NodeRegistryEntry {
  registryPath: string;
}

export type ApplyOperationResult = "applied" | "unchanged" | "deferred";
export type ConflictResolution = "keep-local" | "apply-incoming" | "defer";

export interface ApplyPendingOpsResult {
  appliedCount: number;
  lastAppliedOperationId: string | null;
}
