import { createHash } from 'node:crypto';
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
  // Module 16 (Search, command & AI) — the AI copilot shell (x-copilot). Default off; gates the
  // provider-agnostic copilot `ask` route, whose only provider today is the deterministic local
  // stub. Turning it on exposes no paid model; a real provider is Needs-Peter (NS-13).
  'copilot',
] as const;

export type OptionalModuleFlag = (typeof OPTIONAL_MODULE_FLAGS)[number];

/**
 * Each optional module's default state until an org admin sets it explicitly. The live product
 * modules ship **on** — they are in the app and work today — so a never-touched flag reports the
 * module as on rather than falsely as off (ADM-12: the switches must match reality). The AI copilot
 * is the one default-**off** module: its flag genuinely gates the copilot `ask` route (NS-13), whose
 * only provider today is the local stub, so it must stay off until an admin opts in.
 */
export const DEFAULT_MODULE_ENABLED: Record<OptionalModuleFlag, boolean> = {
  chat: true,
  meetings: true,
  docs: true,
  people: true,
  insights: true,
  automations: true,
  client_portal: true,
  billing: true,
  copilot: false,
};

const KNOWN_FLAGS: ReadonlySet<string> = new Set(OPTIONAL_MODULE_FLAGS);

/** Whether a string is a known optional-module flag key on the fixed allowlist. */
export function isOptionalModuleFlag(value: unknown): value is OptionalModuleFlag {
  return typeof value === 'string' && KNOWN_FLAGS.has(value);
}

// ---- platform-admin v2 · PA-10 ----

/** Who a platform flag's default reaches (0244 `platform_feature_flags.rollout`). */
export const FLAG_ROLLOUTS = ['everyone', 'allowlist', 'percentage'] as const;
export type FlagRollout = (typeof FLAG_ROLLOUTS)[number];

/** One `platform_feature_flags` row, decoded. */
export interface PlatformFlagLayer {
  readonly enabled: boolean;
  readonly rollout: FlagRollout;
  readonly percentage: number | null;
  readonly allowlist: readonly string[];
}

/**
 * The platform side of one organization's flag read: the platform rows, this organization's
 * forced overrides (`platform_org_flag_overrides`, live rows only) and the server locks.
 */
export interface PlatformFlagContext {
  readonly organizationId: string;
  readonly flags: Partial<Record<OptionalModuleFlag, PlatformFlagLayer>>;
  readonly overrides: Partial<Record<OptionalModuleFlag, boolean>>;
  readonly locks: Partial<Record<OptionalModuleFlag, boolean>>;
}

/**
 * The organization's stable bucket 0–99 for one flag: the first four bytes of
 * sha256(`<flag>:<organization id>`) modulo 100. The same organization always lands in the same
 * bucket for a flag, so raising the percentage only ever adds organizations.
 */
export function percentageBucket(flagKey: string, organizationId: string): number {
  const digest = createHash('sha256').update(`${flagKey}:${organizationId}`).digest();
  return digest.readUInt32BE(0) % 100;
}

/** Whether a platform flag's rollout includes the organization. */
export function rolloutIncludes(
  layer: PlatformFlagLayer,
  flagKey: string,
  organizationId: string,
): boolean {
  if (layer.rollout === 'everyone') return true;
  if (layer.rollout === 'allowlist') return layer.allowlist.includes(organizationId);
  const percentage = layer.percentage ?? 0;
  return percentageBucket(flagKey, organizationId) < percentage;
}

/**
 * `TMANAGE_FLAG_LOCKS` — server locks set in Hostinger, `key=on|off` separated by commas
 * (`copilot=off,chat=on`). A locked flag is that value everywhere and the platform screen cannot
 * change it. Unknown keys and junk entries are ignored.
 */
export function parseFlagLocks(
  raw: string | undefined,
): Partial<Record<OptionalModuleFlag, boolean>> {
  const locks: Partial<Record<OptionalModuleFlag, boolean>> = {};
  if (typeof raw !== 'string') return locks;
  for (const part of raw.split(',')) {
    const [key, value] = part.split('=').map((piece) => piece.trim().toLowerCase());
    if (!isOptionalModuleFlag(key)) continue;
    if (value === 'on' || value === 'true' || value === '1') locks[key] = true;
    else if (value === 'off' || value === 'false' || value === '0') locks[key] = false;
  }
  return locks;
}

/**
 * One flag for one organization — the read chain (SPEC §6 0244):
 * server lock → platform override for this organization → the organization's own row →
 * platform default (when its rollout includes the organization) → the code default.
 */
export function resolveFlag(
  key: OptionalModuleFlag,
  orgRow: boolean | undefined,
  platform: PlatformFlagContext | null | undefined,
): boolean {
  const lock = platform?.locks[key];
  if (lock !== undefined) return lock;
  const forced = platform?.overrides[key];
  if (forced !== undefined) return forced;
  if (orgRow !== undefined) return orgRow;
  const layer = platform?.flags[key];
  if (layer && rolloutIncludes(layer, key, platform.organizationId)) return layer.enabled;
  return DEFAULT_MODULE_ENABLED[key];
}

/**
 * Fold stored rows into a resolved map over every known flag: a key with a row takes that row's
 * `enabled`, a key with no row (or any unknown stored key, ignored) resolves to the module's own
 * default ({@link DEFAULT_MODULE_ENABLED} — on for the live modules, off for the copilot).
 * The map is keyed only by allowlisted keys, so the resolved read never leaks a stale or unknown key.
 *
 * PA-10: with `platform` (the platform rows for this organization) the full chain of
 * {@link resolveFlag} applies; without it the result is exactly what it was before.
 */
export function resolveFlags(
  rows: readonly OrgFeatureFlagRow[],
  platform?: PlatformFlagContext | null,
): Record<OptionalModuleFlag, boolean> {
  const byKey = new Map<string, boolean>();
  for (const row of rows) byKey.set(row.flagKey, row.enabled);
  const resolved = {} as Record<OptionalModuleFlag, boolean>;
  for (const key of OPTIONAL_MODULE_FLAGS) {
    resolved[key] = resolveFlag(key, byKey.get(key), platform);
  }
  return resolved;
}
