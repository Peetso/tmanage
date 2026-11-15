import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { PlatformAdminActor } from '../platform-admin/platform-admin.guard.js';
import type { RequestContext } from '../platform-admin/platform-admin.service.js';
import { platformAuditFor } from '../platform-admin/platform-audit.service.js';
import { billingMode, entitlementsFor } from './billing-mode.js';
import type { BillingMode } from './billing-mode.js';
import { DEFAULT_PLAN_ID, PLAN_MONTHLY_CENTS, readPlanId } from './plan-catalog.js';
import type { CatalogPlanId, PlanFeature, PlanLimits } from './plan-catalog.js';
import {
  parseNewPlanVersion,
  planLadderActive,
  readPlanCurrency,
  versionForSubscription,
} from './plan-versions.js';
import type { PlanCurrency, PlanVersion } from './plan-versions.js';
import type { PlanVersionsStore } from './plan-versions.repository.js';
import { SubscriptionRepository } from './subscription.repository.js';

/**
 * 57-02 · the plan ladder's two audiences.
 *
 * - Platform admin (`/v1/platform/plan-versions`): list every published version, and publish a new
 *   one (super admin only; the guard has already required the platform session and step-up).
 * - A workspace (`…/organizations/:orgSlug/billing/plan`): its own current plan, read with
 *   `billing.view`. While the ladder is off (the whole beta) that is the free beta plan for
 *   everyone; when it is on, the version the subscription is pinned to — a newer version does not
 *   move it (grandfathering).
 *
 * Nothing here charges, calls a payment provider or writes a subscription.
 */

export interface PlanVersionView {
  readonly id: string;
  readonly planId: CatalogPlanId;
  readonly version: number;
  readonly currency: PlanCurrency;
  readonly monthlyCents: number | null;
  readonly yearlyCents: number | null;
  readonly limits: PlanLimits;
  readonly features: readonly PlanFeature[];
  readonly effectiveFrom: string;
}

export interface WorkspacePlanView {
  /** `off` during the beta: every workspace is on the free beta plan. */
  readonly ladder: 'off' | 'on';
  readonly billingMode: BillingMode;
  /** The plan whose limits and features apply (the top plan in the free beta). */
  readonly planId: CatalogPlanId;
  /** The `plan_versions` version in use, or `null` while the ladder is off. */
  readonly planVersion: number | null;
  /** On an earlier version than the newest one in force. */
  readonly grandfathered: boolean;
  readonly currency: PlanCurrency;
  readonly monthlyCents: number | null;
  readonly yearlyCents: number | null;
  readonly limits: PlanLimits;
  readonly features: readonly PlanFeature[];
}

function view(version: PlanVersion): PlanVersionView {
  return { ...version, effectiveFrom: version.effectiveFrom.toISOString() };
}

export class PlanVersionsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly store: PlanVersionsStore,
    private readonly subscriptions: SubscriptionRepository = new SubscriptionRepository(),
    private readonly now: () => Date = () => new Date(),
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** `GET /v1/platform/plan-versions` — every version, newest first per plan. */
  async list(context: RequestContext): Promise<readonly PlanVersionView[]> {
    return (await this.store.all(context.correlationId)).map(view);
  }

  /** `POST /v1/platform/plan-versions` — publish the plan's next version. Super admin only. */
  async create(
    actor: PlatformAdminActor,
    body: Readonly<Record<string, unknown>>,
    context: RequestContext,
  ): Promise<PlanVersionView> {
    if (actor.preset !== undefined && actor.preset !== 'super_admin') {
      throw new ApiError(403, 'forbidden', 'Only a super admin can publish a plan version.');
    }
    const input = parseNewPlanVersion(body, this.now());
    const created = await this.store.create(
      input,
      actor.account.userId,
      context.correlationId,
      (v) =>
        platformAuditFor(actor, context, {
          action: 'platform.plan_version_created',
          targetType: 'setting',
          targetId: v.id,
          targetLabel: `${v.planId} v${v.version} ${v.currency}`,
          reason: null,
          afterJson: JSON.stringify(view(v)),
        }),
    );
    return view(created);
  }

  /** `GET …/billing/plan` — the workspace's own current plan. `billing.view`. No write. */
  async current(context: TenantContext, principal: Principal): Promise<WorkspacePlanView> {
    const permitted = authorize({
      principal,
      capability: 'billing.view',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
    if (!permitted) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'denied_billing.view');
    }
    const row = await this.database.read(context, (runner) =>
      this.subscriptions.find(runner, context),
    );
    const storedPlanId = row ? readPlanId(row.planId) : DEFAULT_PLAN_ID;
    const mode = billingMode(this.env);
    if (!planLadderActive(mode, this.env)) {
      const { planId, limits, features } = entitlementsFor(storedPlanId, mode);
      const beta = mode === 'beta_free';
      return {
        ladder: 'off',
        billingMode: mode,
        planId,
        planVersion: null,
        grandfathered: false,
        currency: 'USD',
        monthlyCents: beta ? 0 : PLAN_MONTHLY_CENTS[planId],
        yearlyCents: beta ? 0 : null,
        limits,
        features,
      };
    }
    const currency = readPlanCurrency(row?.currency);
    const versions = await this.store.forPlan(storedPlanId, currency, context.correlationId);
    const at = this.now();
    const pinned = versionForSubscription(versions, storedPlanId, row?.planVersion ?? null, at);
    const newest = versionForSubscription(versions, storedPlanId, null, at);
    const { planId, limits, features } = entitlementsFor(storedPlanId, mode, null, pinned);
    return {
      ladder: 'on',
      billingMode: mode,
      planId,
      planVersion: pinned?.version ?? null,
      grandfathered: pinned !== null && newest !== null && pinned.version < newest.version,
      currency,
      monthlyCents: pinned ? pinned.monthlyCents : PLAN_MONTHLY_CENTS[planId],
      yearlyCents: pinned?.yearlyCents ?? null,
      limits,
      features,
    };
  }
}
