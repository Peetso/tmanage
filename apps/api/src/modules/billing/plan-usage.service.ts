import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import {
  STORAGE_BYTES_METRIC,
  UsageCountersRepository,
} from '../files/usage-counters.repository.js';
import { SubscriptionRepository } from './subscription.repository.js';
import { PlanUsageRepository } from './plan-usage.repository.js';
import { firstOfNextMonthUtc } from './subscription.service.js';
import {
  PLAN_FEATURES,
  PLAN_FEATURE_SET,
  PLAN_IDS,
  PLAN_LIMITS,
  PLAN_MONTHLY_CENTS,
  canonicalPlanId,
  isPlanId,
  readPlanId,
} from './plan-catalog.js';
import type { CatalogPlanId, PlanFeature } from './plan-catalog.js';
import { billingMode, entitlementsFor } from './billing-mode.js';
import type { BillingMode } from './billing-mode.js';

/**
 * Plan and usage — Figma F4 (section 390:22381), Billing / module 19, doc 49 §8 / BIL-01–03.
 *
 * Two reads, no writes and no charge:
 *
 * - {@link PlanUsageService.read} — the current flat plan, what it allows, and what the
 *   organization uses against it (internal people, active projects, storage, clients), each meter
 *   marked `normal`, `near` (80 % or more, or at the limit) or `over`.
 * - {@link PlanUsageService.preview} — what moving to another plan changes: the new price, when it
 *   starts, what is due today (an upgrade pays the prorated difference for the days left in the
 *   period; a downgrade starts when the period ends and costs nothing today), what is gained or
 *   lost, and any limit the organization would be over, with the grace date.
 *
 * No payment provider exists yet (doc 49 §8), so "due today" is computed, never charged. Confirming
 * a change goes through the existing, audited plan-change request (`POST …/plan-change-requests`).
 *
 * Counters come from existing tables (memberships, projects, client memberships, the
 * `storage.bytes` usage counter) and limits from the plan catalog, so there is no new table and no
 * migration. Every read is bound to `context.organizationId`; there is no organization-id input.
 */

export type UsageLevel = 'normal' | 'near' | 'over';

/** One limited (or unlimited) quantity against the plan. `limit` null = no limit. */
export interface PlanUsageMeterView {
  readonly used: number;
  readonly limit: number | null;
  readonly level: UsageLevel;
}

/**
 * What the Plan and usage screen reads — CONTRACT-001 Exact, paired in
 * `e2e/contracts/api-web-shapes.ts` with the web `PlanUsageView`. Dates are `YYYY-MM-DD` (UTC);
 * storage figures are bytes; money is integer cents.
 */
export interface PlanUsageView {
  readonly planId: string;
  readonly pendingChange: boolean;
  readonly currency: string;
  /** Null on Enterprise (priced per contract). */
  readonly monthlyCents: number | null;
  /** The next renewal; null when nothing is billed (Free, Enterprise). */
  readonly renewsOn: string | null;
  readonly level: UsageLevel;
  /** When over a limit: the date by which to free up or change plan. Null otherwise. */
  readonly graceEndsOn: string | null;
  readonly people: PlanUsageMeterView;
  readonly projects: PlanUsageMeterView;
  readonly storage: PlanUsageMeterView;
  readonly clients: number;
  /** The next plan up (for the near/over alert); null on the top listed plan. */
  readonly nextPlanId: string | null;
  readonly nextPlanPeopleLimit: number | null;
  readonly nextPlanStorageBytes: number | null;
  readonly measuredAt: string;
  /**
   * `BILLING_MODE`. `beta_free`: the limits are the top plan's whatever `planId` is stored, nothing
   * is billed (`monthlyCents` 0, `renewsOn` and `nextPlanId` null), and plan changes are refused.
   */
  readonly billingMode: BillingMode;
}

export type PlanChangeKind = 'people' | 'projects' | 'storage' | 'feature';

/** One line of "What changes". `fits` is false when the organization would be over the new limit. */
export interface PlanUsageChangeView {
  readonly kind: PlanChangeKind;
  readonly feature: string | null;
  readonly direction: 'gain' | 'lose';
  readonly fromLimit: number | null;
  readonly toLimit: number | null;
  readonly used: number | null;
  readonly fits: boolean;
}

/** A limit the organization would be over on the target plan. */
export interface PlanUsageOverageView {
  readonly kind: 'people' | 'projects' | 'storage';
  readonly limit: number;
  readonly over: number;
}

/** The change preview — CONTRACT-001 Exact with the web `PlanUsagePreviewView`. Never a charge. */
export interface PlanUsagePreviewView {
  readonly currentPlanId: string;
  readonly targetPlanId: string;
  readonly direction: 'upgrade' | 'downgrade';
  readonly currency: string;
  readonly currentMonthlyCents: number;
  readonly targetMonthlyCents: number;
  /** `YYYY-MM-DD`: today for an upgrade, the period end for a downgrade. */
  readonly startsOn: string;
  readonly startsToday: boolean;
  readonly dueTodayCents: number;
  readonly daysLeft: number;
  /** When the full new price is first charged (the period end). */
  readonly fullPriceFrom: string;
  readonly changes: readonly PlanUsageChangeView[];
  readonly overages: readonly PlanUsageOverageView[];
  readonly graceEndsOn: string | null;
}

/** "Near" starts at 80 % of a limit (and always at the limit itself). */
const NEAR_RATIO = 0.8;
const CURRENCY = 'usd';
const DAY_MS = 86_400_000;

interface Usage {
  readonly planId: CatalogPlanId;
  readonly pendingChange: boolean;
  readonly periodEnd: Date | null;
  readonly people: number;
  readonly projects: number;
  readonly storageBytes: number;
  readonly clients: number;
}

/** The level of one meter. Exported for the unit tests. */
export function levelOf(used: number, limit: number | null): UsageLevel {
  if (limit === null) return 'normal';
  if (used > limit) return 'over';
  if (used >= limit || used >= limit * NEAR_RATIO) return 'near';
  return 'normal';
}

function worst(levels: readonly UsageLevel[]): UsageLevel {
  if (levels.includes('over')) return 'over';
  if (levels.includes('near')) return 'near';
  return 'normal';
}

function isoDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function startOfDayUtc(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/** The same day one month later (clamped to the month's last day), in UTC. */
export function addMonthUtc(at: Date, months = 1): Date {
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(at.getUTCDate(), lastDay)));
}

function priceOf(planId: CatalogPlanId): number {
  return PLAN_MONTHLY_CENTS[planId] ?? 0;
}

/** The next listed plan up the ladder with a list price, or null. */
function nextPlanOf(planId: CatalogPlanId): CatalogPlanId | null {
  const index = PLAN_IDS.indexOf(planId);
  const next = PLAN_IDS[index + 1];
  return next !== undefined && PLAN_MONTHLY_CENTS[next] !== null ? next : null;
}

export class PlanUsageService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly subscriptions: SubscriptionRepository = new SubscriptionRepository(),
    private readonly usage: PlanUsageRepository = new PlanUsageRepository(),
    private readonly counters: UsageCountersRepository = new UsageCountersRepository(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  private authorizeOrg(context: TenantContext, principal: Principal): void {
    const permitted = authorize({
      principal,
      capability: 'org.manage',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
    if (!permitted) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'denied_org.manage');
    }
  }

  private async load(context: TenantContext): Promise<Usage> {
    return this.database.read(context, async (runner) => {
      const row = await this.subscriptions.find(runner, context);
      const people = await this.subscriptions.countInternalPeople(runner, context);
      const projects = await this.usage.countActiveProjects(runner, context);
      const clients = await this.usage.countClientPeople(runner, context);
      const counter = await this.counters.find(runner, context, STORAGE_BYTES_METRIC);
      return {
        planId: readPlanId(row?.planId),
        pendingChange: row?.status === 'pending_change',
        periodEnd: row?.currentPeriodEnd ?? null,
        people,
        projects,
        storageBytes: Number(counter?.usedValue ?? 0) + Number(counter?.reservedValue ?? 0),
        clients,
      };
    });
  }

  /** The current period's end: the stored one, else the first of next month (calendar billing). */
  private periodEnd(usage: Usage, now: Date): Date {
    return usage.periodEnd ?? firstOfNextMonthUtc(now);
  }

  /** The current plan, its limits and the usage against them. `org.manage`. No write. */
  async read(context: TenantContext, principal: Principal): Promise<PlanUsageView> {
    this.authorizeOrg(context, principal);
    const usage = await this.load(context);
    const now = this.now();
    const mode = billingMode();
    const beta = mode === 'beta_free';
    const { limits } = entitlementsFor(usage.planId, mode);
    const people = { used: usage.people, limit: limits.people };
    const projects = { used: usage.projects, limit: limits.activeProjects };
    const storage = { used: usage.storageBytes, limit: limits.storageBytes };
    const meters = [people, projects, storage].map((m) => ({
      ...m,
      level: levelOf(m.used, m.limit),
    }));
    const level = worst(meters.map((m) => m.level));
    const monthlyCents = beta ? 0 : PLAN_MONTHLY_CENTS[usage.planId];
    const periodEnd = this.periodEnd(usage, now);
    const next = beta ? null : nextPlanOf(usage.planId);
    return {
      planId: usage.planId,
      pendingChange: usage.pendingChange,
      currency: CURRENCY,
      monthlyCents,
      renewsOn: monthlyCents !== null && monthlyCents > 0 ? isoDay(periodEnd) : null,
      level,
      graceEndsOn: level === 'over' ? isoDay(addMonthUtc(periodEnd)) : null,
      people: meters[0]!,
      projects: meters[1]!,
      storage: meters[2]!,
      clients: usage.clients,
      nextPlanId: next,
      nextPlanPeopleLimit: next === null ? null : PLAN_LIMITS[next].people,
      nextPlanStorageBytes: next === null ? null : PLAN_LIMITS[next].storageBytes,
      measuredAt: now.toISOString(),
      billingMode: mode,
    };
  }

  /**
   * What changing to `target` would do. 400 for an off-catalog, custom-priced or same plan;
   * `org.manage`. Computes the change; charges nothing and writes nothing.
   */
  async preview(
    context: TenantContext,
    principal: Principal,
    target: string,
  ): Promise<PlanUsagePreviewView> {
    if (!isPlanId(target)) {
      throw new ApiError(
        400,
        'validation_failed',
        'Unknown plan',
        [{ field: 'target', message: 'must be a plan in the catalog' }],
        'off_catalog_plan',
      );
    }
    const targetPlanId = canonicalPlanId(target);
    if (PLAN_MONTHLY_CENTS[targetPlanId] === null) {
      throw new ApiError(
        400,
        'validation_failed',
        'This plan is priced per contract',
        [{ field: 'target', message: 'has no list price; contact sales' }],
        'custom_priced_plan',
      );
    }
    this.authorizeOrg(context, principal);

    const usage = await this.load(context);
    if (usage.planId === targetPlanId) {
      throw new ApiError(
        400,
        'validation_failed',
        'You are already on this plan',
        [{ field: 'target', message: 'must differ from the current plan' }],
        'same_plan',
      );
    }

    const now = this.now();
    const periodEnd = this.periodEnd(usage, now);
    const periodStart = addMonthUtc(periodEnd, -1);
    const currentMonthlyCents = priceOf(usage.planId);
    const targetMonthlyCents = priceOf(targetPlanId);
    const upgrade =
      targetMonthlyCents > currentMonthlyCents ||
      (targetMonthlyCents === currentMonthlyCents &&
        PLAN_IDS.indexOf(targetPlanId) > PLAN_IDS.indexOf(usage.planId));

    const periodDays = Math.max(
      1,
      Math.round((periodEnd.getTime() - periodStart.getTime()) / DAY_MS),
    );
    const daysLeft = Math.min(
      periodDays,
      Math.max(0, Math.ceil((periodEnd.getTime() - startOfDayUtc(now).getTime()) / DAY_MS)),
    );
    const dueTodayCents = upgrade
      ? Math.max(
          0,
          Math.round(((targetMonthlyCents - currentMonthlyCents) * daysLeft) / periodDays),
        )
      : 0;

    const from = PLAN_LIMITS[usage.planId];
    const to = PLAN_LIMITS[targetPlanId];
    const changes = limitChanges(usage, from, to);
    const overages = changes
      .filter((c) => !c.fits && c.toLimit !== null && c.used !== null && c.kind !== 'feature')
      .map((c) => ({
        kind: c.kind as PlanUsageOverageView['kind'],
        limit: c.toLimit as number,
        over: (c.used as number) - (c.toLimit as number),
      }));
    const fromFeatures = new Set<PlanFeature>(PLAN_FEATURE_SET[usage.planId]);
    const toFeatures = new Set<PlanFeature>(PLAN_FEATURE_SET[targetPlanId]);
    const gained = PLAN_FEATURES.filter((f) => toFeatures.has(f) && !fromFeatures.has(f));
    const lost = [...PLAN_FEATURES]
      .reverse()
      .filter((f) => fromFeatures.has(f) && !toFeatures.has(f));
    const featureChanges: PlanUsageChangeView[] = [
      ...gained.map((feature) => featureChange(feature, 'gain')),
      ...lost.map((feature) => featureChange(feature, 'lose')),
    ];

    const startsOn = upgrade ? startOfDayUtc(now) : periodEnd;
    return {
      currentPlanId: usage.planId,
      targetPlanId,
      direction: upgrade ? 'upgrade' : 'downgrade',
      currency: CURRENCY,
      currentMonthlyCents,
      targetMonthlyCents,
      startsOn: isoDay(startsOn),
      startsToday: upgrade,
      dueTodayCents,
      daysLeft,
      fullPriceFrom: isoDay(periodEnd),
      changes: [...changes, ...featureChanges],
      overages,
      graceEndsOn: overages.length > 0 ? isoDay(addMonthUtc(startsOn)) : null,
    };
  }
}

function featureChange(feature: PlanFeature, direction: 'gain' | 'lose'): PlanUsageChangeView {
  return {
    kind: 'feature',
    feature,
    direction,
    fromLimit: null,
    toLimit: null,
    used: null,
    fits: direction === 'gain',
  };
}

/** "More is better" for every limit; null (no limit) is the most. */
function isMore(a: number | null, b: number | null): boolean {
  if (a === b) return false;
  if (a === null) return true;
  if (b === null) return false;
  return a > b;
}

/** The limit lines, ones the organization would not fit first, then people, projects, storage. */
function limitChanges(
  usage: Usage,
  from: (typeof PLAN_LIMITS)[CatalogPlanId],
  to: (typeof PLAN_LIMITS)[CatalogPlanId],
): PlanUsageChangeView[] {
  const pairs: {
    kind: 'people' | 'projects' | 'storage';
    from: number | null;
    to: number | null;
    used: number;
  }[] = [
    { kind: 'people', from: from.people, to: to.people, used: usage.people },
    { kind: 'projects', from: from.activeProjects, to: to.activeProjects, used: usage.projects },
    { kind: 'storage', from: from.storageBytes, to: to.storageBytes, used: usage.storageBytes },
  ];
  const lines = pairs
    .filter((p) => p.from !== p.to)
    .map((p) => ({
      kind: p.kind,
      feature: null,
      direction: isMore(p.to, p.from) ? ('gain' as const) : ('lose' as const),
      fromLimit: p.from,
      toLimit: p.to,
      used: p.used,
      fits: p.to === null || p.used <= p.to,
    }));
  return [...lines.filter((l) => !l.fits), ...lines.filter((l) => l.fits)];
}
