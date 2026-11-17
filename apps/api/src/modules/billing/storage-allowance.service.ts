import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { effectiveStorageMode } from '../google-drive/storage-mode.repository.js';
import type { StorageMode } from '../google-drive/storage-mode.repository.js';
import { billingMode, entitlementsFor } from './billing-mode.js';
import { readPlanId } from './plan-catalog.js';
import { allowanceOf } from './storage-allowance.js';
import type { StorageAllowance } from './storage-allowance.js';
import { StorageAllowanceRepository } from './storage-allowance.repository.js';
import { SubscriptionRepository } from './subscription.repository.js';

/** What the upload doors ask before they reserve bytes on TManage's own storage. */
export interface StorageUploadLimit {
  uploadLimitBytes(context: TenantContext): Promise<number>;
}

/** What the plan-usage read asks, inside its own read. */
export interface StorageAllowanceReader {
  allowanceWith(runner: TenantQueryRunner, context: TenantContext): Promise<StorageAllowance>;
}

/**
 * 57-13r (plan 57 §19.3). The ONE place the temporary storage allowance is decided for a
 * workspace: its plan's figure (the top plan's in `beta_free`), a support raise, and the platform
 * cap (`capBytes`, `STORAGE_ORG_BYTES_LIMIT_BYTES`) over both.
 *
 * {@link uploadLimitBytes} is what every upload door reserves against. While the workspace keeps
 * its files on TManage it is the allowance, so at 100 % a new upload is refused (the existing
 * `storage_quota_exhausted` 422). Once Google Drive or OneDrive is the workspace's storage the
 * allowance never holds an upload back: only the platform cap that protects the shared disk does.
 */
export class StorageAllowanceService implements StorageUploadLimit, StorageAllowanceReader {
  constructor(
    private readonly database: TenantDatabase,
    private readonly capBytes: number,
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
    return allowanceOf(plan.limits.storageBytes, overrideBytes, this.capBytes);
  }

  async uploadLimitBytes(context: TenantContext): Promise<number> {
    return this.database.read(context, async (runner) => {
      if ((await this.storageMode(runner, context)) !== 'tmanage') return this.capBytes;
      return (await this.allowanceWith(runner, context)).limitBytes;
    });
  }
}
