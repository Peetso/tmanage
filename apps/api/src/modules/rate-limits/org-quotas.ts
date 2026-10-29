import type { TenantContext } from '../../common/database/tenant-context.js';
import type { CatalogPlanId } from '../billing/plan-catalog.js';

/**
 * 56-05 — per-organization daily quotas (plan §56-05 "Permissions", from 49 §7 entitlements).
 *
 * One counter per organization, metric and UTC day in `org_quota_counters` (0250). The readers are
 * the features that spend them — 54-04's developer API (`api_calls`), 56-08's webhook relay
 * (`webhook_deliveries`), 56-07's public links (`public_link_views`), 53-15's push (`push_sends`) —
 * each calls {@link OrgQuotaService.consume} with the organization it already resolved. Nothing
 * here is a guard: a quota is charged by code that knows the tenant.
 *
 * `push_sends` has no number in the plan; it mirrors `public_link_views` until 53-15 sets one.
 * Enterprise is the Business figure × 5 until a contract sets its own (via the org override).
 */
export const QUOTA_METRICS = [
  'api_calls',
  'webhook_deliveries',
  'public_link_views',
  'push_sends',
] as const;
export type QuotaMetric = (typeof QUOTA_METRICS)[number];

export const DAILY_QUOTAS: Readonly<Record<CatalogPlanId, Readonly<Record<QuotaMetric, number>>>> =
  {
    free: {
      api_calls: 2_000,
      webhook_deliveries: 500,
      public_link_views: 1_000,
      push_sends: 1_000,
    },
    starter: {
      api_calls: 10_000,
      webhook_deliveries: 5_000,
      public_link_views: 10_000,
      push_sends: 10_000,
    },
    studio: {
      api_calls: 50_000,
      webhook_deliveries: 25_000,
      public_link_views: 50_000,
      push_sends: 50_000,
    },
    business: {
      api_calls: 200_000,
      webhook_deliveries: 100_000,
      public_link_views: 200_000,
      push_sends: 200_000,
    },
    enterprise: {
      api_calls: 1_000_000,
      webhook_deliveries: 500_000,
      public_link_views: 1_000_000,
      push_sends: 1_000_000,
    },
  };

/** A per-org override (SPEC's `organization_limits`); `null`/absent = the plan's value. */
export type QuotaOverrides = Partial<Record<QuotaMetric, number | null>>;

export function dailyQuotaFor(
  planId: CatalogPlanId,
  metric: QuotaMetric,
  overrides?: QuotaOverrides | null,
): number {
  const override = overrides?.[metric];
  return typeof override === 'number' && Number.isInteger(override) && override >= 0
    ? override
    : DAILY_QUOTAS[planId][metric];
}

/** The UTC day a charge at `at` counts against, as `YYYY-MM-DD`. */
export function quotaDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Seconds until the next UTC midnight — the `Retry-After` of a spent daily quota. */
export function secondsUntilNextUtcDay(at: Date): number {
  const next = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - at.getTime()) / 1_000));
}

export interface QuotaCounterStore {
  /** Add `amount` unless it would pass `limit`; all or nothing. Returns the count after. */
  charge(input: {
    readonly context: TenantContext;
    readonly metric: QuotaMetric;
    readonly day: string;
    readonly amount: number;
    readonly limit: number;
  }): Promise<{ readonly admitted: boolean; readonly used: number }>;
}

export type QuotaDecision =
  | { readonly admitted: true; readonly used: number; readonly limit: number }
  | {
      readonly admitted: false;
      readonly used: number;
      readonly limit: number;
      readonly retryAfterSeconds: number;
    };

export class OrgQuotaService {
  constructor(
    private readonly store: QuotaCounterStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Charge `amount` of `metric` to the organization's day. Fails closed: if the counter store
   * throws, the error propagates and the caller's work does not run — a quota exists to stop
   * runaway spend, so an outage must not become unlimited spend.
   */
  async consume(input: {
    readonly context: TenantContext;
    readonly planId: CatalogPlanId;
    readonly metric: QuotaMetric;
    readonly amount?: number;
    readonly overrides?: QuotaOverrides | null;
  }): Promise<QuotaDecision> {
    const at = this.now();
    const limit = dailyQuotaFor(input.planId, input.metric, input.overrides);
    const amount = Math.max(1, Math.floor(input.amount ?? 1));
    const result = await this.store.charge({
      context: input.context,
      metric: input.metric,
      day: quotaDay(at),
      amount,
      limit,
    });
    return result.admitted
      ? { admitted: true, used: result.used, limit }
      : {
          admitted: false,
          used: result.used,
          limit,
          retryAfterSeconds: secondsUntilNextUtcDay(at),
        };
  }
}
