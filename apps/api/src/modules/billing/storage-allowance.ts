import { naturalBand, usagePercent } from '../files/usage-thresholds.js';
import type { ThresholdBand } from '../files/usage-thresholds.js';

/**
 * 57-13r (plan 57 §19.3). The temporary storage allowance: what a workspace may keep on TManage's
 * own storage before it connects Google Drive or OneDrive. Never sold, never raised by money.
 *
 * Three numbers decide it: the plan's figure (`limits_json.storageBytes`, null on Enterprise = no
 * set limit), a support raise for this workspace (`organization_limits` `storage_bytes_limit`, set
 * by a platform admin on the workspace's Plan page), and the platform-wide safety ceiling
 * (`STORAGE_ORG_BYTES_LIMIT_BYTES`), which counts only when the operator set it explicitly. With
 * no plan figure, no raise and no ceiling there is no TManage-storage cap at all. Pure: the
 * service in `storage-allowance.service.ts` reads the inputs.
 */

/**
 * No byte limit: large enough that no sum of bytes reaches it, and still a bound value the
 * reservation's `<=` compares against.
 */
export const NO_WORKSPACE_LIMIT = Number.MAX_SAFE_INTEGER;

/** Which figure the allowance stops at: what a refusal names in plain words. */
export type StorageLimitSource = 'plan' | 'support' | 'platform';

export interface StorageAllowance {
  /** {@link NO_WORKSPACE_LIMIT} when nothing limits the workspace. */
  readonly limitBytes: number;
  /** The figure that decides {@link limitBytes}; null = no limit. */
  readonly limitedBy: StorageLimitSource | null;
  /** A platform admin raised (or set) this workspace's allowance above its plan's figure. */
  readonly raisedBySupport: boolean;
  /**
   * False when nothing sets a figure (Enterprise without a raise, no ceiling): screens say
   * "No set limit", draw no bar and send no notice. True whenever a figure refuses, so the card,
   * the notices and the refusal read the same number.
   */
  readonly hasFigure: boolean;
}

export function allowanceOf(
  planBytes: number | null,
  overrideBytes: number | null,
  ceilingBytes: number | null,
): StorageAllowance {
  const wanted = overrideBytes ?? planBytes;
  const source: StorageLimitSource | null =
    overrideBytes !== null ? 'support' : planBytes !== null ? 'plan' : null;
  const ceilingWins = ceilingBytes !== null && (wanted === null || ceilingBytes < wanted);
  const limitedBy = ceilingWins ? 'platform' : source;
  return {
    limitBytes: ceilingWins ? ceilingBytes : (wanted ?? NO_WORKSPACE_LIMIT),
    limitedBy,
    raisedBySupport: overrideBytes !== null && (planBytes === null || overrideBytes > planBytes),
    hasFigure: limitedBy !== null,
  };
}

/**
 * The plans whose allowance the explicit ceiling cuts short (a figure above it, or no figure):
 * what the boot line names so the operator sees the env value overrides a plan. Empty when the
 * ceiling is unset or above every plan.
 */
export function plansCutByCeiling(
  ceilingBytes: number | null,
  plans: Readonly<Record<string, { readonly storageBytes: number | null }>>,
): string[] {
  if (ceilingBytes === null) return [];
  return Object.entries(plans)
    .filter(([, limits]) => limits.storageBytes === null || limits.storageBytes > ceilingBytes)
    .map(([plan]) => plan);
}

/** Whole percent of the allowance in use (may pass 100 when a commit overshoots). */
export function storagePercent(usedBytes: number, limitBytes: number): number {
  return Math.floor(usagePercent(usedBytes, 0, limitBytes));
}

/** The notice step reached: 70, 85, 95 or 100 (doc 49 §6), else 0. */
export function storageThreshold(usedBytes: number, limitBytes: number): ThresholdBand {
  return naturalBand(usagePercent(usedBytes, 0, limitBytes));
}

/**
 * The refusal's sentence, by the figure that was hit. The web maps each exact sentence to its
 * catalog key (`describe-error.ts`), so the reader sees it in their language. The plan sentence is
 * the 100 % notice's own words (`planStorage.notice100`).
 */
export const STORAGE_FULL_MESSAGES: Readonly<Record<'allowance' | 'platform', string>> = {
  allowance:
    'Your temporary storage is full. New uploads wait until you connect Google Drive or OneDrive, or move files there. Nothing is deleted.',
  platform:
    'This workspace has reached the most TManage stores for one workspace. New uploads wait until you connect Google Drive or OneDrive, or move files there. Nothing is deleted.',
};

export function storageFullMessage(limitedBy: StorageLimitSource | null): string {
  return limitedBy === 'platform'
    ? STORAGE_FULL_MESSAGES.platform
    : STORAGE_FULL_MESSAGES.allowance;
}
