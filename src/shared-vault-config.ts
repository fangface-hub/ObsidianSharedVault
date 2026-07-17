import type { SharedVaultSettings } from "./shared-vault-types";

export const FALLBACK_USER_ID = "shared-user";
export const DEFAULT_CACHE_TTL_DAYS = 30;
export const DAY_IN_MS = 24 * 60 * 60 * 1000;
export const NODE_REGISTRY_DIR = "node-registry";

export function getDefaultUserId(): string {
  const loginUserId = process.env.USERNAME?.trim() || process.env.USER?.trim() || process.env.LOGNAME?.trim();
  return loginUserId && loginUserId.length > 0 ? loginUserId : FALLBACK_USER_ID;
}

export const DEFAULT_SETTINGS: SharedVaultSettings = {
  userId: getDefaultUserId(),
  autoSyncIntervalSec: 15,
  cacheTtlDays: DEFAULT_CACHE_TTL_DAYS,
  operationCacheDir: "operation-cache",
  snapshotDir: "snapshots"
};
