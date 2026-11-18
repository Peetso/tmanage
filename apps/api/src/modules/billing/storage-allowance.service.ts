import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { effectiveStorageMode } from '../google-drive/storage-mode.repository.js';
import type { StorageMode } from '../google-drive/storage-mode.repository.js';
import { billingMode, entitlementsFor } from './billing-mode.js';
import { readPlanId } from './plan-catalog.js';
import { NO_WORKSPACE_LIMIT, allowanceOf } from './storage-allowance.js';
import type { StorageAllowance, StorageLimitSource } from './storage-allowance.js';
import { StorageAllowanceRepository } from './storage-allowance.repository.js';
import { SubscriptionRepository } from './subscription.repository.js';

/**
 * A workspace that keeps its files in its own Drive/OneDrive has no workspace byte limit on
 * TManage: a file only passes through on its way there.
 */
export { NO_WORKSPACE_LIMIT };

/** The two readings of the one allowance (both from {@link StorageAllowanceService.limitsFor}). */
export interface StorageLimits {
  /** What usage is measured against: notices, bands, the figures on screen. */
  readonly allowanceBytes: number;
  /** What a new upload is refused at: the allowance, or none once Drive/OneDrive is the storage. */
  readonly uploadLimitBytes: number;
  /** Which figure {@link uploadLimitBytes} stops at, for the refusal's words; null = none. */
  readonly limitedBy: StorageLimitSource | null;
}

/** What every door, meter and reader of the storage allowance asks. */
export interface StorageUploadLimit {
  limitsFor(context: TenantContext): Promise<StorageLimits>;
}

/** What the plan-usage read asks, inside its own read. */
export interface StorageAllowanceReader {
  allowanceWith(runner: TenantQueryRunner, context: TenantContext): Promise<StorageAllowance>;
}

/**
 * 57-13r (plan 57 §19.3). The ONE place the temporary storage allowance is decided for a
 * workspace: its plan's figure (the top plan's in `beta_free`), a support raise, and the platform
 * safety ceiling (`ceilingBytes`, `STORAGE_ORG_BYTES_LIMIT_BYTES` only when set explicitly, else
 * null) over both. No figure and no ceiling: no TManage-storage cap.
 *
 * {@link limitsFor} is the one call every upload door, the inbound-mail attachments, the usage
 * reconciler's bands, the storage usage read and the inbox notice make. While the workspace keeps
 * its files on TManage it is the allowance, so at 100 % a new upload is refused (the existing
 * `storage_quota_exhausted` 422). Once Google Drive or OneDrive is the workspace's storage the
 * workspace has no byte limit on TManage at all (a file passes through on its way to the Drive);
 * the per-file limit, the open-upload count and the daily upload count still apply.
 */
export class StorageAllowanceService implements StorageUploadLimit, StorageAllowanceReader {
  constructor(
    private readonly database: TenantDatabase,
    private readonly ceilingBytes: number | null,
    private readonly subscriptions: Pick<
      SubscriptionRepository,
      'find'
    > = new SubscriptionRepository(),
    private readonly overrides: Pick<
      StorageAllowanceRepository,
      'findOverrideBytes'
    > = new StorageAllowanceRepository(),
    private readonly storageMode: (
      runner: TenantQueryRunner,
      context: TenantContext,
    ) => Promise<StorageMode> = effectiveStorageMode,
  ) {}

  async allowanceWith(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<StorageAllowance> {
    const subscription = await this.subscriptions.find(runner, context);
    const overrideBytes = await this.overrides.findOverrideBytes(runner, context);
    const plan = entitlementsFor(readPlanId(subscription?.planId), billingMode());
    return allowanceOf(plan.limits.storageBytes, overrideBytes, this.ceilingBytes);
  }

  async limitsFor(context: TenantContext): Promise<StorageLimits> {
    return this.database.read(context, async (runner) => {
      const mode = await this.storageMode(runner, context);
      const { limitBytes, limitedBy } = await this.allowanceWith(runner, context);
      const onTManage = mode === 'tmanage';
      return {
        allowanceBytes: limitBytes,
        uploadLimitBytes: onTManage ? limitBytes : NO_WORKSPACE_LIMIT,
        limitedBy: onTManage ? limitedBy : null,
      };
    });
  }
}
