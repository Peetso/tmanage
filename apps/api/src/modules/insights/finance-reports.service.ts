import {
  authorize,
  burnOf,
  capacityMinutes,
  isBudgetType,
  marginBp,
  toCsv,
  utilisationBp,
} from '@tmanage/domain';
import type { AuditAction, Capability, Principal } from '@tmanage/domain';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import type { BudgetBurnRepository } from '../projects/budget-burn.repository.js';
import {
  FINANCE_REPORTS,
  MAX_REPORT_ROWS,
  PERSON_REPORTS_SETTING_KEY,
  PROFITABILITY_GROUPS,
  UNBILLED_GROUPS,
  UTILISATION_PAGE,
  capacityRange,
  parseAfter,
  parseChoice,
  parseRange,
  personReportsEnabled,
  rebuildThrottled,
  rebuildWindow,
} from './finance-reports-rules.js';
import type { FinanceReport, ReportRange, UnbilledGroup } from './finance-reports-rules.js';
import type {
  FinanceReportsRepository,
  ProfitabilityDbRow,
  ProfitabilityGroup,
} from './finance-reports.repository.js';

/**
 * 52-14 (R17-a) — profitability, unbilled and utilisation reports, their CSV, and the on-demand
 * facts rebuild.
 *
 * Capabilities (no `capabilities.ts` edit — the 52-23 rule): the plan's `finance.report` is
 * `finance.view`; the plan's `rate.view_cost` is `finance.manage` (the stand-in
 * `rates.controller.ts` uses). Without `finance.manage` the cost columns are never selected and
 * the `costMinor` / `marginBp` keys are absent from every row and CSV — omitted, never blanked.
 * The org setting `finance.person_reports = off` refuses per-person reads (by=person and
 * utilisation) to callers without `finance.manage`. Per-person rows carry a membership id and a
 * display name — never activity data. Every figure but unbilled comes from `finance_daily_facts`.
 */

const FINANCE_VIEW: Capability = 'finance.view';
const FINANCE_MANAGE: Capability = 'finance.manage';

export interface ProfitabilityRowView {
  readonly projectId?: string | null;
  readonly clientOrganizationId?: string | null;
  readonly membershipId?: string | null;
  readonly name: string | null;
  readonly billableMinutes: number;
  readonly nonbillableMinutes: number;
  readonly writeoffMinutes: number;
  readonly unpricedMinutes: number;
  readonly billedMinor: number;
  readonly expenseMinor: number;
  readonly invoicedMinor: number;
  readonly unbilledMinor: number;
  readonly budgetUsedBp?: number | null;
  readonly costMinor?: number;
  readonly marginBp?: number | null;
}

export interface ProfitabilityView {
  readonly by: ProfitabilityGroup;
  readonly from: string;
  readonly to: string;
  readonly currency: string | null;
  /** 52-09 invoices are not built: `invoicedMinor` is 0 and unbilled equals billed. */
  readonly invoicingAvailable: false;
  readonly computedAt: string | null;
  readonly truncated: boolean;
  readonly rows: readonly ProfitabilityRowView[];
}

export interface UnbilledRowView {
  readonly projectId?: string | null;
  readonly clientOrganizationId?: string | null;
  readonly name: string | null;
  readonly minutes: number;
  readonly amountMinor: number;
  readonly unpricedMinutes: number;
}

export interface UnbilledView {
  readonly by: UnbilledGroup;
  readonly from: string;
  readonly to: string;
  readonly currency: string | null;
  readonly truncated: boolean;
  readonly rows: readonly UnbilledRowView[];
}

export interface UtilisationRowView {
  readonly membershipId: string;
  readonly name: string;
  readonly billableMinutes: number;
  readonly totalMinutes: number;
  readonly capacityMinutes: number;
  readonly utilisationBp: number | null;
}

export interface UtilisationView {
  readonly from: string;
  readonly to: string;
  readonly computedAt: string | null;
  readonly rows: readonly UtilisationRowView[];
  readonly nextAfter: string | null;
}

export interface FinanceCsv {
  readonly filename: string;
  readonly body: string;
}

export interface RebuildView {
  readonly from: string;
  readonly to: string;
  readonly rows: number;
  readonly computedAt: string;
}

export interface FinanceReportsQuery {
  readonly by?: unknown;
  readonly from?: unknown;
  readonly to?: unknown;
  readonly after?: unknown;
  readonly report?: unknown;
}

export interface FinanceReportsServiceOptions {
  readonly database: Pick<TenantDatabase, 'transaction' | 'read'>;
  readonly repository: FinanceReportsRepository;
  readonly budgets: Pick<BudgetBurnRepository, 'facts'>;
  readonly audit: Pick<AuditService, 'record'>;
  readonly now?: () => Date;
}

const ID_FIELD: Readonly<
  Record<ProfitabilityGroup, 'projectId' | 'clientOrganizationId' | 'membershipId'>
> = {
  project: 'projectId',
  client: 'clientOrganizationId',
  person: 'membershipId',
};

const n = (value: number | string | undefined): number => Number(value ?? 0);

export class FinanceReportsService {
  private readonly now: () => Date;

  constructor(private readonly options: FinanceReportsServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async profitability(
    context: TenantContext,
    principal: Principal,
    query: FinanceReportsQuery,
  ): Promise<ProfitabilityView> {
    this.require(principal, context, FINANCE_VIEW);
    const by = parseChoice(query.by, PROFITABILITY_GROUPS, 'by', 'project');
    const range = parseRange(query.from, query.to, this.now());
    const withCost = this.allows(principal, context, FINANCE_MANAGE);
    return this.options.database.read(context, async (r) => {
      if (by === 'person') await this.requirePersonReports(r, context, withCost);
      return this.profitabilityIn(r, context, by, range, withCost);
    });
  }

  async unbilled(
    context: TenantContext,
    principal: Principal,
    query: FinanceReportsQuery,
  ): Promise<UnbilledView> {
    this.require(principal, context, FINANCE_VIEW);
    const by = parseChoice(query.by, UNBILLED_GROUPS, 'by', 'project');
    const range = parseRange(query.from, query.to, this.now());
    return this.options.database.read(context, (r) => this.unbilledIn(r, context, by, range));
  }

  async utilisation(
    context: TenantContext,
    principal: Principal,
    query: FinanceReportsQuery,
  ): Promise<UtilisationView> {
    this.require(principal, context, FINANCE_VIEW);
    const range = parseRange(query.from, query.to, this.now());
    const after = parseAfter(query.after);
    const manage = this.allows(principal, context, FINANCE_MANAGE);
    return this.options.database.read(context, async (r) => {
      await this.requirePersonReports(r, context, manage);
      return this.utilisationIn(r, context, range, after);
    });
  }

  /** `report.export` (route) + `finance.view` (here). Audited `finance.report_exported`. */
  async exportCsv(
    context: TenantContext,
    principal: Principal,
    query: FinanceReportsQuery,
  ): Promise<FinanceCsv> {
    this.require(principal, context, FINANCE_VIEW);
    const report = parseChoice<FinanceReport>(
      query.report,
      FINANCE_REPORTS,
      'report',
      'profitability',
    );
    const range = parseRange(query.from, query.to, this.now());
    const withCost = this.allows(principal, context, FINANCE_MANAGE);
    return this.options.database.transaction(context, async (tx) => {
      let body: string;
      let groupBy = '';
      if (report === 'profitability') {
        const by = parseChoice(query.by, PROFITABILITY_GROUPS, 'by', 'project');
        if (by === 'person') await this.requirePersonReports(tx, context, withCost);
        groupBy = by;
        body = profitabilityCsv(
          await this.profitabilityIn(tx, context, by, range, withCost),
          withCost,
        );
      } else if (report === 'unbilled') {
        const by = parseChoice(query.by, UNBILLED_GROUPS, 'by', 'project');
        groupBy = by;
        body = unbilledCsv(await this.unbilledIn(tx, context, by, range));
      } else {
        await this.requirePersonReports(tx, context, withCost);
        body = await this.utilisationCsv(tx, context, range);
      }
      await this.audited(tx, context, 'finance.report_exported', {
        report,
        group_by: groupBy,
        range_from: range.from,
        range_to: range.to,
      });
      return { filename: `${report}-${range.from}-${range.to}.csv`, body };
    });
  }

  /** `finance.manage`. One transaction; at most once per 5 minutes per organization. */
  async rebuild(context: TenantContext, principal: Principal): Promise<RebuildView> {
    this.require(principal, context, FINANCE_MANAGE);
    const at = this.now();
    const window = rebuildWindow(at);
    return this.options.database.transaction(context, async (tx) => {
      const repo = this.options.repository;
      if (rebuildThrottled(await repo.lastComputedAt(tx, context), at)) {
        throw new ApiError(
          429,
          'rate_limited',
          MESSAGES.rateLimited,
          undefined,
          'finance.rebuild_throttled',
        );
      }
      const rows = await repo.rebuildFacts(tx, context, window.from, window.to, at);
      await this.audited(tx, context, 'finance.facts_rebuilt', {
        range_from: window.from,
        range_to: window.to,
        row_count: rows,
      });
      return { ...window, rows, computedAt: at.toISOString() };
    });
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  private async profitabilityIn(
    r: TenantQueryRunner,
    context: TenantContext,
    by: ProfitabilityGroup,
    range: ReportRange,
    withCost: boolean,
  ): Promise<ProfitabilityView> {
    const repo = this.options.repository;
    const found = await repo.profitability(r, context, {
      by,
      ...range,
      withCost,
      limit: MAX_REPORT_ROWS + 1,
    });
    const rows = found.slice(0, MAX_REPORT_ROWS);
    const ids = rows.map((row) => row.group_key);
    const names = await repo.names(r, context, by, ids);
    const budgetBp = by === 'project' ? await this.budgetUsed(r, context, ids) : null;
    return {
      by,
      ...range,
      currency: await repo.baseCurrency(r, context),
      invoicingAvailable: false,
      computedAt: (await repo.lastComputedAt(r, context))?.toISOString() ?? null,
      truncated: found.length > MAX_REPORT_ROWS,
      rows: rows.map((row) => profitabilityRow(by, row, names, budgetBp, withCost)),
    };
  }

  private async unbilledIn(
    r: TenantQueryRunner,
    context: TenantContext,
    by: UnbilledGroup,
    range: ReportRange,
  ): Promise<UnbilledView> {
    const repo = this.options.repository;
    const found = await repo.unbilled(r, context, { ...range, limit: MAX_REPORT_ROWS + 1 });
    const truncated = found.length > MAX_REPORT_ROWS;
    const projectRows = found.slice(0, MAX_REPORT_ROWS);
    const clients = by === 'client' ? await repo.clientByProject(r, context) : null;
    const totals = new Map<
      string,
      { minutes: number; amountMinor: number; unpricedMinutes: number }
    >();
    for (const row of projectRows) {
      const key = clients === null ? row.project_id : (clients.get(row.project_id) ?? '');
      const prev = totals.get(key) ?? { minutes: 0, amountMinor: 0, unpricedMinutes: 0 };
      totals.set(key, {
        minutes: prev.minutes + n(row.minutes),
        amountMinor: prev.amountMinor + n(row.amount_minor),
        unpricedMinutes: prev.unpricedMinutes + n(row.unpriced_minutes),
      });
    }
    const names = await repo.names(r, context, by, [...totals.keys()]);
    const idField = by === 'project' ? 'projectId' : 'clientOrganizationId';
    return {
      by,
      ...range,
      currency: await repo.baseCurrency(r, context),
      truncated,
      rows: [...totals.entries()].map(([key, t]) => ({
        [idField]: key === '' ? null : key,
        name: names.get(key) ?? null,
        ...t,
      })),
    };
  }

  private async utilisationIn(
    r: TenantQueryRunner,
    context: TenantContext,
    range: ReportRange,
    after: string,
  ): Promise<UtilisationView> {
    const repo = this.options.repository;
    const page = await repo.membersPage(r, context, after, UTILISATION_PAGE + 1);
    const members = page.slice(0, UTILISATION_PAGE);
    const ids = members.map((m) => m.membershipId);
    const minutes = await repo.memberMinutes(r, context, ids, range.from, range.to);
    const capacity = await repo.capacity(r, context, ids);
    return {
      ...range,
      computedAt: (await repo.lastComputedAt(r, context))?.toISOString() ?? null,
      nextAfter: page.length > UTILISATION_PAGE ? (members.at(-1)?.membershipId ?? null) : null,
      rows: members.map((m) => {
        const used = minutes.get(m.membershipId) ?? { billableMinutes: 0, totalMinutes: 0 };
        const cap = capacity.get(m.membershipId);
        const covered = cap === undefined ? null : capacityRange(range, cap.effectiveFrom);
        const capMinutes =
          cap === undefined || covered === null
            ? 0
            : capacityMinutes(cap.weeklyHours, covered.from, covered.to);
        return {
          membershipId: m.membershipId,
          name: m.displayName,
          billableMinutes: used.billableMinutes,
          totalMinutes: used.totalMinutes,
          capacityMinutes: capMinutes,
          utilisationBp: utilisationBp(used.billableMinutes, capMinutes),
        };
      }),
    };
  }

  /** Every page of utilisation, for the CSV (bounded by the org's member count). */
  private async utilisationCsv(
    r: TenantQueryRunner,
    context: TenantContext,
    range: ReportRange,
  ): Promise<string> {
    const rows: UtilisationRowView[] = [];
    let after = '';
    for (;;) {
      const page = await this.utilisationIn(r, context, range, after);
      rows.push(...page.rows);
      if (page.nextAfter === null || rows.length >= MAX_REPORT_ROWS) break;
      after = page.nextAfter;
    }
    return toCsv(
      rows.map((row) => [
        row.membershipId,
        row.name,
        row.billableMinutes,
        row.totalMinutes,
        row.capacityMinutes,
        row.utilisationBp ?? '',
      ]),
      [
        'Member id',
        'Name',
        'Billable minutes',
        'Total minutes',
        'Capacity minutes',
        'Utilisation bp',
      ],
    );
  }

  private async budgetUsed(
    r: TenantQueryRunner,
    context: TenantContext,
    projectIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>> {
    const facts = await this.options.budgets.facts(
      r,
      context,
      projectIds.filter((id) => id !== ''),
    );
    return new Map(
      facts.map((f) => [
        f.projectId,
        burnOf({
          type: isBudgetType(f.budgetType) ? f.budgetType : 'hours',
          budgetMinutes: f.budgetMinutes === null ? null : Number(f.budgetMinutes),
          budgetAmountMinor: f.budgetAmountMinor === null ? null : Number(f.budgetAmountMinor),
          usedMinutes: Number(f.usedMinutesCache),
          usedAmountMinor: Number(f.usedAmountCacheMinor),
        }).percentBp,
      ]),
    );
  }

  // ── Policy ────────────────────────────────────────────────────────────────

  private async requirePersonReports(
    r: TenantQueryRunner,
    context: TenantContext,
    manage: boolean,
  ): Promise<void> {
    if (manage) return;
    const stored = await this.options.repository.setting(r, context, PERSON_REPORTS_SETTING_KEY);
    if (!personReportsEnabled(stored)) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        [{ field: 'by', message: 'person_reports_disabled' }],
        'finance.person_reports_disabled',
      );
    }
  }

  private allows(principal: Principal, context: TenantContext, capability: Capability): boolean {
    return authorize({
      principal,
      capability,
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
  }

  private require(principal: Principal, context: TenantContext, capability: Capability): void {
    if (!this.allows(principal, context, capability)) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'finance.denied');
    }
  }

  private async audited(
    tx: TenantQueryRunner,
    context: TenantContext,
    action: AuditAction,
    metadata: Readonly<Record<string, string | number | boolean | null>>,
  ): Promise<void> {
    await this.options.audit.record(tx, context, {
      action,
      result: 'allowed',
      objectId: context.organizationId,
      actorUserId: context.userId,
      metadata,
      changes: [],
    });
  }
}

/** One profitability row. Cost and margin keys exist only when `withCost`. */
export function profitabilityRow(
  by: ProfitabilityGroup,
  row: ProfitabilityDbRow,
  names: ReadonlyMap<string, string>,
  budgetBp: ReadonlyMap<string, number> | null,
  withCost: boolean,
): ProfitabilityRowView {
  const key = row.group_key;
  const billedMinor = n(row.billed_minor);
  const invoicedMinor = n(row.invoiced_minor);
  const expenseMinor = n(row.expense_minor);
  const view: ProfitabilityRowView = {
    [ID_FIELD[by]]: key === '' ? null : key,
    name: names.get(key) ?? null,
    billableMinutes: n(row.billable_minutes),
    nonbillableMinutes: n(row.nonbillable_minutes),
    writeoffMinutes: n(row.writeoff_minutes),
    unpricedMinutes: n(row.unpriced_minutes),
    billedMinor,
    expenseMinor,
    invoicedMinor,
    unbilledMinor: billedMinor - invoicedMinor,
    ...(budgetBp === null ? {} : { budgetUsedBp: budgetBp.get(key) ?? null }),
  };
  if (!withCost) return view;
  const costMinor = n(row.cost_minor);
  return { ...view, costMinor, marginBp: marginBp(billedMinor, costMinor, expenseMinor) };
}

export function profitabilityCsv(view: ProfitabilityView, withCost: boolean): string {
  const header = [
    'Id',
    'Name',
    'Billable minutes',
    'Non-billable minutes',
    'Write-off minutes',
    'Unpriced minutes',
    'Billed',
    'Expenses',
    'Unbilled',
    ...(withCost ? ['Cost', 'Margin bp'] : []),
  ];
  const field = ID_FIELD[view.by];
  return toCsv(
    view.rows.map((row) => [
      row[field] ?? '',
      row.name ?? '',
      row.billableMinutes,
      row.nonbillableMinutes,
      row.writeoffMinutes,
      row.unpricedMinutes,
      row.billedMinor,
      row.expenseMinor,
      row.unbilledMinor,
      ...(withCost ? [row.costMinor ?? 0, row.marginBp ?? ''] : []),
    ]),
    header,
  );
}

export function unbilledCsv(view: UnbilledView): string {
  return toCsv(
    view.rows.map((row) => [
      row.projectId ?? row.clientOrganizationId ?? '',
      row.name ?? '',
      row.minutes,
      row.amountMinor,
      row.unpricedMinutes,
    ]),
    ['Id', 'Name', 'Unbilled minutes', 'Unbilled amount', 'Unpriced minutes'],
  );
}
