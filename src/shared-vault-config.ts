import type { SharedVaultSettings } from "./shared-vault-types";

export const FALLBACK_USER_ID = "shared-user";
export const DEFAULT_CACHE_TTL_DAYS = 30;
export const DAY_IN_MS = 24 * 60 * 60 * 1000;
export const NODE_REGISTRY_DIR = "node-registry";

export const DEFAULT_SETTINGS: SharedVaultSettings = {
  userId: FALLBACK_USER_ID,
  autoSyncIntervalSec: 15,
  cacheTtlDays: DEFAULT_CACHE_TTL_DAYS,
  operationCacheDir: "operation-cache",
  snapshotDir: "snapshots"
};
