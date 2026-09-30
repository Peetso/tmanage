import type { OrgFeatureFlagRow } from '../../common/database/schema.js';

/**
 * The logic half of per-org optional-module feature flags (Administration module 18, x278) — the
 * fixed allowlist of togglable optional modules and the resolution that folds stored rows into it.
 *
 * ## Why a fixed allowlist
 *
 * `38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §3` names the optional/"later" modules an org may turn
 * on or off; the MVP-core modules are never optional and are not in this set. The set is fixed in
 * code, not derived from stored rows, for two reasons the slice depends on: a PUT may only name a
 * key on it (a key off it is a 400 with no upsert, so the table can never hold a flag for a module
 * that does not exist), and the resolved read enumerates it (so an unknown or never-set key resolves
 * to its default rather than being absent from the map). Editing this list is how a module becomes
 * optional; no `capabilities.ts` change is involved.
 */
export const OPTIONAL_MODULE_FLAGS = [
  'chat',
  'meetings',
  'docs',
  'people',
  'insights',
  'automations',
  'client_portal',
  'billing',
] as const;

export type OptionalModuleFlag = (typeof OPTIONAL_MODULE_FLAGS)[number];

/** Every optional-module flag defaults to off until an org admin turns it on. */
const DEFAULT_ENABLED = false;

const KNOWN_FLAGS: ReadonlySet<string> = new Set(OPTIONAL_MODULE_FLAGS);

/** Whether a string is a known optional-module flag key on the fixed allowlist. */
export function isOptionalModuleFlag(value: unknown): value is OptionalModuleFlag {
  return typeof value === 'string' && KNOWN_FLAGS.has(value);
}

/**
 * Fold stored rows into a resolved map over every known flag: a key with a row takes that row's
 * `enabled`, a key with no row (or any unknown stored key, ignored) resolves to the default (off).
 * The map is keyed only by allowlisted keys, so the resolved read never leaks a stale or unknown key.
 */
export function resolveFlags(
  rows: readonly OrgFeatureFlagRow[],
): Record<OptionalModuleFlag, boolean> {
  const byKey = new Map<string, boolean>();
  for (const row of rows) byKey.set(row.flagKey, row.enabled);
  const resolved = {} as Record<OptionalModuleFlag, boolean>;
  for (const key of OPTIONAL_MODULE_FLAGS) {
    resolved[key] = byKey.get(key) ?? DEFAULT_ENABLED;
  }
  return resolved;
}
