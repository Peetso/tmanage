import { authorize, burnOf, forecastExhaustion, isBudgetType } from '@tmanage/domain';
import type { Burn, BurnStatus, Capability, Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { BudgetBurnRepository } from './budget-burn.repository.js';
import type { BudgetBurnFacts, BurnBucketRow } from './budget-burn.repository.js';
import { ProjectsRepository } from './projects.repository.js';

/**
 * 52-05 (R16-b) — the burn report, the portfolio burn column and the portal projection.
 *
 * Capabilities (52-23 stand-in rule, no new keys): reading burn is `work.read` with a project
 * relation; burn **by person** is manager-only (`project.manage` on the project); every money figure
 * (amounts, minor units) is dropped unless the caller holds `finance.view`. The client projection is
 * a dedicated three-field shape, served only when the team switched `client_visible` on.
 */

/**
 * Extra burn beyond time entries. 52-07 expenses (R16-c) wire their own implementation through DI
 * later; until then nothing is added.
 */
export interface BurnSources {
  expensesMinor(context: TenantContext, projectId: string): Promise<number>;
}

export const NO_EXTRA_BURN_SOURCES: BurnSources = { expensesMinor: async () => 0 };

/** The DI token the budget module provides {@link BudgetBurnService} under. */
export const BUDGET_BURN_SERVICE = Symbol.for('tmanage.BudgetBurnService');

const FINANCE_VIEW: Capability = 'finance.view';
const MAX_RANGE_DAYS = 731;
const DEFAULT_RANGE_DAYS = 84;
const DEFAULT_PERSON_PAGE = 50;
const MAX_PERSON_PAGE = 200;
/** Weeks within two years: never more than this many buckets. */
const MAX_WEEK_BUCKETS = 106;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type BurnGroupBy = 'week' | 'person' | 'phase';

export interface BurnQueryInput {
  readonly from?: string;
  readonly to?: string;
  readonly groupBy?: string;
  readonly after?: string;
  readonly limit?: string;
}

export interface BurnBucketView {
  readonly key: string;
  readonly minutes: number;
  readonly billableMinutes: number;
  readonly unpricedMinutes: number;
  readonly amountMinor?: number;
}

export interface BurnReportView {
  readonly projectId: string;
  readonly from: string;
  readonly to: string;
  readonly groupBy: 'week' | 'person';
  readonly buckets: readonly BurnBucketView[];
  readonly nextCursor: string | null;
  /** Week view only: at the range's average weekly minutes, the day the hours budget runs out. */
  readonly forecastExhaustedOn: string | null;
}

export interface PortfolioBurnView {
  readonly percentBp: number;
  readonly status: BurnStatus;
}

/** Exactly what a client may see. No amount, rate, cost or minor-unit key, ever. */
export interface PortalBudgetView {
  readonly percentUsed: number;
  readonly remainingHours?: number;
  readonly status: BurnStatus;
}

export function holdsFinanceView(principal: Principal, organizationId: string): boolean {
  return authorize({
    principal,
    capability: FINANCE_VIEW,
    resource: { organizationId, projectId: null, audience: 'internal', lifecycle: 'active' },
  }).allowed;
}

/** The burn of one budget from its cached figures plus the extra sources. */
export function burnFromFacts(facts: BudgetBurnFacts, expensesMinor: number): Burn {
  return burnOf({
    type: isBudgetType(facts.budgetType) ? facts.budgetType : 'hours',
    budgetMinutes: facts.budgetMinutes,
    budgetAmountMinor: facts.budgetAmountMinor,
    usedMinutes: facts.usedMinutesCache,
    usedAmountMinor: facts.usedAmountCacheMinor + (facts.includeExpenses ? expensesMinor : 0),
  });
}

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The request is invalid', [{ field, message }]);
}

function addDays(day: string, days: number): string {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

function dayOrThrow(field: string, raw: string): string {
  if (!DAY_PATTERN.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
    throw invalid(field, 'must be a YYYY-MM-DD date');
  }
  return raw;
}

export class BudgetBurnService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly repository: BudgetBurnRepository = new BudgetBurnRepository(),
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
    private readonly sources: BurnSources = NO_EXTRA_BURN_SOURCES,
    private readonly today: () => string = () => new Date().toISOString().slice(0, 10),
  ) {}

  private allowed(principal: Principal, capability: Capability, projectId: string, org: string) {
    return authorize({
      principal,
      capability,
      resource: { organizationId: org, projectId, audience: 'internal', lifecycle: 'active' },
    }).allowed;
  }

  /** `GET …/projects/:projectId/budget/burn`. */
  async burn(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    input: BurnQueryInput,
  ): Promise<BurnReportView> {
    const project = await this.database.read(context, (runner) =>
      this.projects.findById(runner, context, projectId),
    );
    const org = context.organizationId;
    if (!project || !this.allowed(principal, 'work.read', projectId, org)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
    }

    const groupBy = (input.groupBy ?? 'week') as BurnGroupBy;
    if (!['week', 'person', 'phase'].includes(groupBy)) {
      throw invalid('groupBy', 'must be week, person or phase');
    }
    // `work_items` carries no `phase_id` column, so entries cannot be attributed to a phase.
    if (groupBy === 'phase') {
      throw new ApiError(422, 'validation_failed', 'phase_grouping_unavailable', [
        { field: 'groupBy', message: 'phase_grouping_unavailable' },
      ]);
    }
    if (groupBy === 'person' && !this.allowed(principal, 'project.manage', projectId, org)) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden);
    }

    const to = input.to === undefined ? this.today() : dayOrThrow('to', input.to);
    const from =
      input.from === undefined ? addDays(to, -DEFAULT_RANGE_DAYS) : dayOrThrow('from', input.from);
    const spanDays = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    if (spanDays < 0) throw invalid('from', 'must not be after to');
    if (spanDays > MAX_RANGE_DAYS) throw invalid('to', 'the range may span at most two years');

    let limit = MAX_WEEK_BUCKETS;
    if (groupBy === 'person') {
      const parsed = input.limit === undefined ? DEFAULT_PERSON_PAGE : Number(input.limit);
      if (!Number.isSafeInteger(parsed) || parsed < 1) throw invalid('limit', 'must be >= 1');
      limit = Math.min(parsed, MAX_PERSON_PAGE);
    }

    const [rows, facts] = await this.database.read(context, async (runner) => {
      const buckets = await this.repository.buckets(runner, context, {
        projectId,
        from,
        to,
        groupBy,
        ...(groupBy === 'person' && input.after !== undefined ? { after: input.after } : {}),
        limit: limit + 1,
      });
      const found = await this.repository.facts(runner, context, [projectId]);
      return [buckets, found[0] ?? null] as const;
    });

    const page = rows.slice(0, limit);
    const money = holdsFinanceView(principal, org);
    return {
      projectId,
      from,
      to,
      groupBy,
      buckets: page.map((row) => bucketView(row, money)),
      nextCursor: groupBy === 'person' && rows.length > limit ? page[page.length - 1]!.key : null,
      forecastExhaustedOn:
        groupBy === 'week' && facts?.budgetMinutes != null
          ? forecastExhaustion(
              (page.reduce((sum, row) => sum + row.minutes, 0) * 7) / Math.max(spanDays + 1, 7),
              facts.budgetMinutes - facts.usedMinutesCache,
              this.today(),
            )
          : null,
    };
  }

  /** The portfolio's burn column: `{percentBp, status}` per project that has a budget. */
  async portfolioBurn(
    context: TenantContext,
    projectIds: readonly string[],
  ): Promise<ReadonlyMap<string, PortfolioBurnView>> {
    const facts = await this.database.read(context, (runner) =>
      this.repository.facts(runner, context, projectIds),
    );
    const out = new Map<string, PortfolioBurnView>();
    for (const row of facts) {
      const expenses = row.includeExpenses
        ? await this.sources.expensesMinor(context, row.projectId)
        : 0;
      const burn = burnFromFacts(row, expenses);
      out.set(row.projectId, { percentBp: burn.percentBp, status: burn.status });
    }
    return out;
  }

  /**
   * `GET …/portal/projects/:projectId/budget`. A client who may read the project, and only when
   * the team set `client_visible`: otherwise 404 — the same answer as an unknown project.
   */
  async portalProjection(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<PortalBudgetView> {
    const mayRead = authorize({
      principal,
      capability: 'client_projection.read',
      resource: {
        organizationId: principal.organizationId,
        projectId,
        audience: 'client_visible',
        clientOrganizationId: principal.clientOrganizationId,
        lifecycle: 'active',
      },
    }).allowed;
    if (!mayRead) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    const facts = await this.database.read(context, (runner) =>
      this.repository.facts(runner, context, [projectId]),
    );
    const row = facts[0];
    if (!row || !row.clientVisible) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    const expenses = row.includeExpenses ? await this.sources.expensesMinor(context, projectId) : 0;
    const burn = burnFromFacts(row, expenses);
    return {
      percentUsed: Math.round(burn.percentBp / 100),
      ...(burn.remainingMinutes !== null && row.budgetType !== 'money'
        ? { remainingHours: Math.round((burn.remainingMinutes / 60) * 10) / 10 }
        : {}),
      status: burn.status,
    };
  }
}

function bucketView(row: BurnBucketRow, money: boolean): BurnBucketView {
  return {
    key: row.key,
    minutes: row.minutes,
    billableMinutes: row.billableMinutes,
    unpricedMinutes: row.unpricedMinutes,
    ...(money ? { amountMinor: row.amountMinor } : {}),
  };
}
