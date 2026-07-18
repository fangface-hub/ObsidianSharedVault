import type { SharedVaultSettings } from "./shared-vault-types";

export const DEFAULT_CACHE_TTL_DAYS = 30;
export const DAY_IN_MS = 24 * 60 * 60 * 1000;
export const SHARED_VAULT_STORAGE_RELATIVE_DIR = "shared-vault";
export const LEGACY_NODE_REGISTRY_DIR = "node-registry";
export const LEGACY_OPERATION_CACHE_DIR = "operation-cache";
export const LEGACY_SNAPSHOT_DIR = "snapshots";

export const DEFAULT_SETTINGS: SharedVaultSettings = {
  autoSyncIntervalSec: 15,
  cacheTtlDays: DEFAULT_CACHE_TTL_DAYS,
  operationCacheDir: LEGACY_OPERATION_CACHE_DIR,
  snapshotDir: LEGACY_SNAPSHOT_DIR
};
