import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { STORAGE_BYTES_METRIC } from './usage-counters.repository.js';
import { NO_WORKSPACE_LIMIT } from '../billing/storage-allowance.js';
import type { StorageUploadLimit } from '../billing/storage-allowance.service.js';
import type { UsageCountersRepository } from './usage-counters.repository.js';
import type { UsageLedgerRepository } from './usage-ledger.repository.js';

/**
 * USAGE-001 slice 5 — the read side of the storage quota counter.
 *
 * `49-PRICING-ENTITLEMENTS-AND-STORAGE-POLICY` §8 wants the billing screen to show what an
 * organization has used, what it has reserved and how much it may use. Slices 1–3 built the
 * write side — the counter, the ledger, the reconciler that stamps `reconciled_at`. This is the
 * one read that turns that row into the three numbers a screen renders, and nothing more: it
 * takes no bytes in, moves no counter, and never touches the write paths x63's threshold-band
 * slice owns.
 *
 * ## The tenant is the principal's, never the caller's
 *
 * The method takes a {@link TenantContext} the guard resolved from an active membership and a
 * {@link Principal} built from the same, and reads the counter for `context.organizationId`.
 * There is no organization-id parameter to accept, so a caller cannot ask for another tenant's
 * usage: the only organization this method can name is the one the request was already proven to
 * belong to (`04-SECURITY-PRIVACY` §4).
 */

/**
 * What the billing screen reads — CONTRACT-001 Exact, paired in `e2e/contracts/api-web-shapes.ts`
 * with `OrganizationUsage` in `apps/web/src/lib/api/usage.ts`.
 *
 * `unit` is a literal, not a bare string: the two counter columns are byte counts (§6), and
 * pinning the unit in the type keeps a future metric that meters something else from being
 * rendered against this screen's labels without a compile error somewhere. `reconciledAt` is the
 * last time the reconciler checked the row against its ledger (slice 3), null until it first runs.
 */
export interface UsageView {
  readonly used: number;
  /** Of `used`, the bytes of preview images the viewer made (R4: they count against the quota). */
  readonly previews: number;
  readonly reserved: number;
  readonly quota: number;
  readonly unit: 'bytes';
  readonly reconciledAt: string | null;
}

export class UsageService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly counters: UsageCountersRepository,
    private readonly ledger: UsageLedgerRepository,
    private readonly config: ApiConfig,
    /** 57-13r. The one storage allowance; absent, the platform cap. */
    private readonly allowance: StorageUploadLimit | null = null,
  ) {}

  /**
   * Read the storage counter for the caller's own tenant.
   *
   * Authorized in the service as well as at the route (`25-AUTH-AND-TENANT-ISOLATION` §3: route
   * guards are UX only, the API authorizes every action). The gating capability is `org.manage`.
   *
   * DIVERGENCE — AUTH-16 name pending. `49-…` §8 imagines a dedicated billing/usage capability,
   * but none exists in code (implementation-status question 7). Reusing `org.manage` scopes this
   * read to owners — the same population the threshold notice goes to — rather than inventing a
   * capability the role matrix does not define. Re-point this one line if AUTH-16 lands a name.
   */
  async read(context: TenantContext, principal: Principal): Promise<UsageView> {
    const verdict = authorize({
      principal,
      capability: 'org.manage',
      resource: {
        organizationId: context.organizationId,
        // Null: org-level resource (organization settings), no project relation to lean on.
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        `usage.read:${verdict.code}`,
      );
    }

    const [counter, previews] = await this.database.read(context, (runner) =>
      Promise.all([
        this.counters.find(runner, context, STORAGE_BYTES_METRIC),
        this.ledger.sumPreviewBytes(runner, context),
      ]),
    );

    return {
      used: Number(counter?.usedValue ?? 0),
      previews,
      reserved: Number(counter?.reservedValue ?? 0),
      quota: this.allowance
        ? (await this.allowance.limitsFor(context)).allowanceBytes
        : (this.config.storageOrgBytesLimit ?? NO_WORKSPACE_LIMIT),
      unit: 'bytes',
      reconciledAt: counter?.reconciledAt?.toISOString() ?? null,
    };
  }
}
