/**
 * The read chain of one per-organization feature flag (SPEC §6 0244, PA-10), pure, so the API
 * (`modules/admin/feature-flags.service.ts`) and the worker (a sweep gated by a flag) resolve a
 * flag the same way:
 *
 * server lock → platform override for this organization → the organization's own row →
 * platform default (when its rollout includes the organization) → the code default.
 *
 * No hashing here: the percentage bucket is sha256-based and the domain index stays free of
 * `node:crypto` (the web bundle imports it), so the caller passes the bucket's digest in.
 */

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

/** The text whose sha256 decides an organization's percentage bucket for one flag. */
export function percentageBucketInput(flagKey: string, organizationId: string): string {
  return `${flagKey}:${organizationId}`;
}

/** The bucket 0–99 from that sha256 digest: its first four bytes, big-endian, modulo 100. */
export function percentageBucketOfDigest(digest: Uint8Array): number {
  const first = ((digest[0]! << 24) | (digest[1]! << 16) | (digest[2]! << 8) | digest[3]!) >>> 0;
  return first % 100;
}

/** Whether a platform flag's rollout includes the organization, given its bucket for the flag. */
export function rolloutIncludesBucket(
  layer: PlatformFlagLayer,
  bucket: number,
  organizationId: string,
): boolean {
  if (layer.rollout === 'everyone') return true;
  if (layer.rollout === 'allowlist') return layer.allowlist.includes(organizationId);
  return bucket < (layer.percentage ?? 0);
}

export interface FlagChainInput {
  readonly organizationId: string;
  readonly lock: boolean | undefined;
  readonly override: boolean | undefined;
  readonly orgRow: boolean | undefined;
  readonly layer: PlatformFlagLayer | undefined;
  /** The organization's percentage bucket for this flag (only read for a percentage rollout). */
  readonly bucket: () => number;
  readonly codeDefault: boolean;
}

export function resolveFlagChain(input: FlagChainInput): boolean {
  if (input.lock !== undefined) return input.lock;
  if (input.override !== undefined) return input.override;
  if (input.orgRow !== undefined) return input.orgRow;
  const { layer } = input;
  if (
    layer &&
    rolloutIncludesBucket(
      layer,
      layer.rollout === 'percentage' ? input.bucket() : 0,
      input.organizationId,
    )
  ) {
    return layer.enabled;
  }
  return input.codeDefault;
}

/**
 * `TMANAGE_FLAG_LOCKS` — `key=on|off` separated by commas (`copilot=off,chat=on`). Keys the
 * caller does not know and junk entries are ignored.
 */
export function parseFlagLockList<K extends string>(
  raw: string | undefined,
  isKey: (value: unknown) => value is K,
): Partial<Record<K, boolean>> {
  const locks: Partial<Record<K, boolean>> = {};
  if (typeof raw !== 'string') return locks;
  for (const part of raw.split(',')) {
    const [key, value] = part.split('=').map((piece) => piece.trim().toLowerCase());
    if (!isKey(key)) continue;
    if (value === 'on' || value === 'true' || value === '1') locks[key] = true;
    else if (value === 'off' || value === 'false' || value === '0') locks[key] = false;
  }
  return locks;
}
