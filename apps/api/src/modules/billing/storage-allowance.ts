import { naturalBand, usagePercent } from '../files/usage-thresholds.js';
import type { ThresholdBand } from '../files/usage-thresholds.js';

/**
 * 57-13r (plan 57 §19.3). The temporary storage allowance: what a workspace may keep on TManage's
 * own storage before it connects Google Drive or OneDrive. Never sold, never raised by money.
 *
 * Three numbers decide it, in this order: the plan's figure (`limits_json.storageBytes`, null on
 * Enterprise = by agreement), a support raise for this workspace (`organization_limits`
 * `storage_bytes_limit`, set by a platform admin on the workspace's Plan page), and the platform
 * cap (`STORAGE_ORG_BYTES_LIMIT_BYTES`) that neither of the first two can go past. Pure: the
 * service in `storage-allowance.service.ts` reads the inputs.
 */
export interface StorageAllowance {
  readonly limitBytes: number;
  /** A platform admin raised (or set) this workspace's allowance above its plan's figure. */
  readonly raisedBySupport: boolean;
}

export function allowanceOf(
  planBytes: number | null,
  overrideBytes: number | null,
  capBytes: number,
): StorageAllowance {
  const wanted = overrideBytes ?? planBytes ?? capBytes;
  return {
    limitBytes: Math.min(wanted, capBytes),
    raisedBySupport: overrideBytes !== null && (planBytes === null || overrideBytes > planBytes),
  };
}

/** Whole percent of the allowance in use (may pass 100 when a commit overshoots). */
export function storagePercent(usedBytes: number, limitBytes: number): number {
  return Math.floor(usagePercent(usedBytes, 0, limitBytes));
}

/** The notice step reached: 70, 85, 95 or 100 (doc 49 §6), else 0. */
export function storageThreshold(usedBytes: number, limitBytes: number): ThresholdBand {
  return naturalBand(usagePercent(usedBytes, 0, limitBytes));
}
