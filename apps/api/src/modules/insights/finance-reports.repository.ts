import { mergeFinanceFacts, uuidv7 } from '@tmanage/domain';
import type { ExpenseFactInput, FinanceFact, TimeFactInput } from '@tmanage/domain';
import { dateFromDriver } from '../../common/database/drizzle.js';
import type {
  QueryRows,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';

/**
 * 52-14 (R17-a) — the finance facts rebuild and the report reads. Every statement names the
 * acting organization as a bound parameter (25 §6, the tenant guard).
 *
 * ## The rebuild (copied verbatim into `apps/worker/src/common/database/finance-facts-store.ts`)
 *
 * Four reads — the time-log groups ({@link TIME_FACTS_SQL}), the expense groups
 * ({@link EXPENSE_FACTS_SQL}), each project's first client ({@link PROJECT_CLIENTS_SQL}) and the
 * base currency ({@link BASE_CURRENCY_SQL}) — folded by the pure `mergeFinanceFacts`, then DELETE
 * of the window and INSERT of the rows. Money follows the 52-05 burn rule
 * (`budget-burn.repository.ts`): `billed` = SUM(rate_snapshot_minor × minutes) / 60 over billable
 * entries, a missing snapshot prices at 0 and counts as unpriced; `cost` sums every entry. The
 * rebuild is a pure function of the sources, so running it twice writes the same rows.
 *
 * ## The reads
 *
 * Profitability and utilisation read `finance_daily_facts`; unbilled reads `work_item_time_logs`
 * directly so it is live. Cost columns are only selected when the caller may see them.
 */

// ── Rebuild ─────────────────────────────────────────────────────────────────

export const TIME_FACTS_SQL = `SELECT DATE_FORMAT(l.spent_on, '%Y-%m-%d') AS day,
       COALESCE(l.project_id, '') AS project_id,
       l.logged_by AS membership_id,
       COALESCE(SUM(CASE WHEN l.billable = 1 THEN l.minutes ELSE 0 END), 0) AS billable_minutes,
       COALESCE(SUM(CASE WHEN l.billable = 0 THEN l.minutes ELSE 0 END), 0) AS nonbillable_minutes,
       COALESCE(SUM(CASE WHEN l.billable = 0 AND p.billable_default = 1 THEN l.minutes ELSE 0 END), 0)
         AS writeoff_minutes,
       COALESCE(SUM(CASE WHEN l.billable = 1 AND l.rate_snapshot_minor IS NULL THEN l.minutes ELSE 0 END), 0)
         AS unpriced_minutes,
       COALESCE(FLOOR(SUM(CASE WHEN l.billable = 1 THEN COALESCE(l.rate_snapshot_minor, 0) * l.minutes ELSE 0 END) / 60), 0)
         AS billed_minor,
       COALESCE(FLOOR(SUM(COALESCE(l.cost_snapshot_minor, 0) * l.minutes) / 60), 0) AS cost_minor
  FROM work_item_time_logs l
  LEFT JOIN projects p ON p.organization_id = l.organization_id AND p.id = l.project_id
 WHERE l.organization_id = ? AND l.spent_on BETWEEN ? AND ?
 GROUP BY l.spent_on, l.project_id, l.logged_by`;

// Approved or invoiced only; the base amount plus the markup when billable, floored per expense
// (`expenseChargeMinor` in packages/domain/src/money/profitability.ts).
export const EXPENSE_FACTS_SQL = `SELECT DATE_FORMAT(e.spent_on, '%Y-%m-%d') AS day,
       COALESCE(e.project_id, '') AS project_id,
       e.membership_id AS membership_id,
       COALESCE(SUM(COALESCE(e.amount_base_minor, 0)
         + CASE WHEN e.billable = 1 AND e.markup_bp > 0
                THEN FLOOR(COALESCE(e.amount_base_minor, 0) * e.markup_bp / 10000) ELSE 0 END), 0)
         AS expense_minor
  FROM expenses e
 WHERE e.organization_id = ? AND e.state IN ('approved', 'invoiced')
   AND e.spent_on BETWEEN ? AND ?
 GROUP BY e.spent_on, e.project_id, e.membership_id`;

// "First" client = the oldest link; the caller keeps the first row per project.
export const PROJECT_CLIENTS_SQL = `SELECT pc.project_id, pc.client_organization_id
  FROM project_clients pc
 WHERE pc.organization_id = ?
 ORDER BY pc.project_id, pc.created_at, pc.id`;

export const BASE_CURRENCY_SQL = `SELECT fp.base_currency
  FROM org_finance_profiles fp
 WHERE fp.organization_id = ?
 LIMIT 1`;

export const DELETE_FACTS_SQL = `DELETE FROM finance_daily_facts
 WHERE organization_id = ? AND day BETWEEN ? AND ?`;

export const INSERT_FACTS_HEAD = `INSERT INTO finance_daily_facts
   (id, organization_id, day, project_id, client_organization_id, membership_id,
    billable_minutes, nonbillable_minutes, writeoff_minutes, unpriced_minutes,
    billed_minor, cost_minor, expense_minor, invoiced_minor, currency, computed_at)
 VALUES `;
export const INSERT_FACTS_TUPLE = '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
export const INSERT_FACTS_BATCH = 200;

export const LAST_COMPUTED_SQL = `SELECT MAX(f.computed_at) AS last_computed
  FROM finance_daily_facts f
 WHERE f.organization_id = ?`;

interface TimeFactDbRow {
  readonly day: string;
  readonly project_id: string;
  readonly membership_id: string;
  readonly billable_minutes: number | string;
  readonly nonbillable_minutes: number | string;
  readonly writeoff_minutes: number | string;
  readonly unpriced_minutes: number | string;
  readonly billed_minor: number | string;
  readonly cost_minor: number | string;
}

interface ExpenseFactDbRow {
  readonly day: string;
  readonly project_id: string;
  readonly membership_id: string;
  readonly expense_minor: number | string;
}

/** Shared by the API and (copied) the worker: map the raw rows the rebuild reads. */
export function timeFactOf(row: TimeFactDbRow): TimeFactInput {
  return {
    day: String(row.day),
    projectId: row.project_id,
    membershipId: row.membership_id,
    billableMinutes: Number(row.billable_minutes),
    nonbillableMinutes: Number(row.nonbillable_minutes),
    writeoffMinutes: Number(row.writeoff_minutes),
    unpricedMinutes: Number(row.unpriced_minutes),
    billedMinor: Number(row.billed_minor),
    costMinor: Number(row.cost_minor),
  };
}

export function expenseFactOf(row: ExpenseFactDbRow): ExpenseFactInput {
  return {
    day: String(row.day),
    projectId: row.project_id,
    membershipId: row.membership_id,
    expenseMinor: Number(row.expense_minor),
  };
}

/** The first client per project from {@link PROJECT_CLIENTS_SQL}'s ordered rows. */
export function firstClientByProject(
  rows: readonly { readonly project_id: string; readonly client_organization_id: string }[],
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const row of rows)
    if (!map.has(row.project_id)) map.set(row.project_id, row.client_organization_id);
  return map;
}

/** The bound values of one inserted fact, in {@link INSERT_FACTS_HEAD}'s column order. */
export function factInsertValues(
  organizationId: string,
  fact: FinanceFact,
  computedAt: Date,
): (string | number | Date | null)[] {
  return [
    uuidv7(),
    organizationId,
    fact.day,
    fact.projectId,
    fact.clientOrganizationId,
    fact.membershipId,
    fact.billableMinutes,
    fact.nonbillableMinutes,
    fact.writeoffMinutes,
    fact.unpricedMinutes,
    fact.billedMinor,
    fact.costMinor,
    fact.expenseMinor,
    fact.invoicedMinor,
    fact.currency,
    computedAt,
  ];
}

// ── Reads ───────────────────────────────────────────────────────────────────

export type ProfitabilityGroup = 'project' | 'client' | 'person';

const GROUP_KEY: Readonly<Record<ProfitabilityGroup, string>> = {
  project: 'f.project_id',
  client: "COALESCE(f.client_organization_id, '')",
  person: 'f.membership_id',
};

/** A LIMIT as a literal integer: prepared statements cannot carry it on every server version. */
const limitOf = (limit: number): string => String(Math.min(Math.max(1, Math.trunc(limit)), 5_000));

export function profitabilitySql(by: ProfitabilityGroup, withCost: boolean, limit: number): string {
  return `SELECT ${GROUP_KEY[by]} AS group_key,
       SUM(f.billable_minutes) AS billable_minutes,
       SUM(f.nonbillable_minutes) AS nonbillable_minutes,
       SUM(f.writeoff_minutes) AS writeoff_minutes,
       SUM(f.unpriced_minutes) AS unpriced_minutes,
       SUM(f.billed_minor) AS billed_minor,
       SUM(f.expense_minor) AS expense_minor,
       SUM(f.invoiced_minor) AS invoiced_minor${withCost ? ',\n       SUM(f.cost_minor) AS cost_minor' : ''}
  FROM finance_daily_facts f
 WHERE f.organization_id = ? AND f.day BETWEEN ? AND ?
 GROUP BY group_key
 ORDER BY group_key
 LIMIT ${limitOf(limit)}`;
}

export const unbilledSql = (
  limit: number,
): string => `SELECT COALESCE(l.project_id, '') AS project_id,
       COALESCE(SUM(l.minutes), 0) AS minutes,
       COALESCE(FLOOR(SUM(COALESCE(l.rate_snapshot_minor, 0) * l.minutes) / 60), 0) AS amount_minor,
       COALESCE(SUM(CASE WHEN l.rate_snapshot_minor IS NULL THEN l.minutes ELSE 0 END), 0)
         AS unpriced_minutes
  FROM work_item_time_logs l
 WHERE l.organization_id = ? AND l.billable = 1 AND l.invoice_line_id IS NULL
   AND l.spent_on BETWEEN ? AND ?
 GROUP BY l.project_id
 ORDER BY project_id
 LIMIT ${limitOf(limit)}`;

export const membersPageSql = (
  limit: number,
): string => `SELECT m.id AS membership_id, u.display_name
  FROM memberships m
  JOIN users u ON u.id = m.user_id
 WHERE m.organization_id = ? AND m.status = 'active' AND m.role <> 'platform_support'
   AND m.id > ?
 ORDER BY m.id
 LIMIT ${limitOf(limit)}`;

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

export const memberMinutesSql = (n: number): string => `SELECT f.membership_id,
       SUM(f.billable_minutes) AS billable_minutes,
       SUM(f.billable_minutes + f.nonbillable_minutes) AS total_minutes
  FROM finance_daily_facts f
 WHERE f.organization_id = ? AND f.day BETWEEN ? AND ? AND f.membership_id IN (${placeholders(n)})
 GROUP BY f.membership_id`;

export const capacitySql = (n: number): string => `SELECT pc.membership_id, pc.weekly_hours,
       DATE_FORMAT(pc.effective_from, '%Y-%m-%d') AS effective_from
  FROM person_capacity pc
 WHERE pc.organization_id = ? AND pc.membership_id IN (${placeholders(n)})`;

export const projectNamesSql = (n: number): string => `SELECT p.id, p.name
  FROM projects p
 WHERE p.organization_id = ? AND p.id IN (${placeholders(n)})`;

export const clientNamesSql = (n: number): string => `SELECT co.id, co.name
  FROM client_organizations co
 WHERE co.organization_id = ? AND co.id IN (${placeholders(n)})`;

export const memberNamesSql = (n: number): string => `SELECT m.id, u.display_name AS name
  FROM memberships m
  JOIN users u ON u.id = m.user_id
 WHERE m.organization_id = ? AND m.id IN (${placeholders(n)})`;

export const SETTING_SQL = `SELECT s.setting_value
  FROM org_settings s
 WHERE s.organization_id = ? AND s.setting_key = ?
 LIMIT 1`;

export interface ProfitabilityDbRow {
  readonly group_key: string;
  readonly billable_minutes: number | string;
  readonly nonbillable_minutes: number | string;
  readonly writeoff_minutes: number | string;
  readonly unpriced_minutes: number | string;
  readonly billed_minor: number | string;
  readonly expense_minor: number | string;
  readonly invoiced_minor: number | string;
  readonly cost_minor?: number | string;
}

export interface UnbilledDbRow {
  readonly project_id: string;
  readonly minutes: number | string;
  readonly amount_minor: number | string;
  readonly unpriced_minutes: number | string;
}

export interface MemberMinutes {
  readonly billableMinutes: number;
  readonly totalMinutes: number;
}

export interface CapacityRow {
  readonly weeklyHours: number;
  readonly effectiveFrom: string;
}

const NAME_CHUNK = 500;

async function rows<T>(
  runner: TenantQueryRunner,
  sql: string,
  params: readonly (string | number | Date | null)[],
): Promise<readonly T[]> {
  return (await runner.execute<QueryRows>(sql, params)) as unknown as readonly T[];
}

export class FinanceReportsRepository {
  /**
   * DELETE the window, then INSERT it again from the sources. Run inside one transaction (the
   * caller's). Returns the number of fact rows written.
   */
  async rebuildFacts(
    tx: TenantQueryRunner,
    context: TenantContext,
    fromDay: string,
    toDay: string,
    computedAt: Date,
  ): Promise<number> {
    const org = context.organizationId;
    const time = await rows<TimeFactDbRow>(tx, TIME_FACTS_SQL, [org, fromDay, toDay]);
    const expenses = await rows<ExpenseFactDbRow>(tx, EXPENSE_FACTS_SQL, [org, fromDay, toDay]);
    const clients = await rows<{ project_id: string; client_organization_id: string }>(
      tx,
      PROJECT_CLIENTS_SQL,
      [org],
    );
    const currency = await rows<{ base_currency: string }>(tx, BASE_CURRENCY_SQL, [org]);
    const facts = mergeFinanceFacts({
      time: time.map(timeFactOf),
      expenses: expenses.map(expenseFactOf),
      clientByProject: firstClientByProject(clients),
      currency: currency[0]?.base_currency ?? null,
    });
    await tx.execute(DELETE_FACTS_SQL, [org, fromDay, toDay]);
    for (let i = 0; i < facts.length; i += INSERT_FACTS_BATCH) {
      const batch = facts.slice(i, i + INSERT_FACTS_BATCH);
      await tx.execute(
        INSERT_FACTS_HEAD + batch.map(() => INSERT_FACTS_TUPLE).join(', '),
        batch.flatMap((fact) => factInsertValues(org, fact, computedAt)),
      );
    }
    return facts.length;
  }

  async lastComputedAt(runner: TenantQueryRunner, context: TenantContext): Promise<Date | null> {
    const found = await rows<{ last_computed: unknown }>(runner, LAST_COMPUTED_SQL, [
      context.organizationId,
    ]);
    return dateFromDriver(found[0]?.last_computed);
  }

  async baseCurrency(runner: TenantQueryRunner, context: TenantContext): Promise<string | null> {
    const found = await rows<{ base_currency: string }>(runner, BASE_CURRENCY_SQL, [
      context.organizationId,
    ]);
    return found[0]?.base_currency ?? null;
  }

  async setting(
    runner: TenantQueryRunner,
    context: TenantContext,
    key: string,
  ): Promise<string | undefined> {
    const found = await rows<{ setting_value: string }>(runner, SETTING_SQL, [
      context.organizationId,
      key,
    ]);
    return found[0]?.setting_value;
  }

  async profitability(
    runner: TenantQueryRunner,
    context: TenantContext,
    query: {
      readonly by: ProfitabilityGroup;
      readonly from: string;
      readonly to: string;
      readonly withCost: boolean;
      readonly limit: number;
    },
  ): Promise<readonly ProfitabilityDbRow[]> {
    return rows<ProfitabilityDbRow>(
      runner,
      profitabilitySql(query.by, query.withCost, query.limit),
      [context.organizationId, query.from, query.to],
    );
  }

  async unbilled(
    runner: TenantQueryRunner,
    context: TenantContext,
    query: { readonly from: string; readonly to: string; readonly limit: number },
  ): Promise<readonly UnbilledDbRow[]> {
    return rows<UnbilledDbRow>(runner, unbilledSql(query.limit), [
      context.organizationId,
      query.from,
      query.to,
    ]);
  }

  async clientByProject(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<ReadonlyMap<string, string>> {
    return firstClientByProject(
      await rows<{ project_id: string; client_organization_id: string }>(
        runner,
        PROJECT_CLIENTS_SQL,
        [context.organizationId],
      ),
    );
  }

  /** Active internal members, keyset by membership id. */
  async membersPage(
    runner: TenantQueryRunner,
    context: TenantContext,
    after: string,
    limit: number,
  ): Promise<readonly { readonly membershipId: string; readonly displayName: string }[]> {
    const found = await rows<{ membership_id: string; display_name: string }>(
      runner,
      membersPageSql(limit),
      [context.organizationId, after],
    );
    return found.map((r) => ({ membershipId: r.membership_id, displayName: r.display_name }));
  }

  async memberMinutes(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipIds: readonly string[],
    from: string,
    to: string,
  ): Promise<ReadonlyMap<string, MemberMinutes>> {
    const map = new Map<string, MemberMinutes>();
    if (membershipIds.length === 0) return map;
    const found = await rows<{
      membership_id: string;
      billable_minutes: number | string;
      total_minutes: number | string;
    }>(runner, memberMinutesSql(membershipIds.length), [
      context.organizationId,
      from,
      to,
      ...membershipIds,
    ]);
    for (const r of found) {
      map.set(r.membership_id, {
        billableMinutes: Number(r.billable_minutes),
        totalMinutes: Number(r.total_minutes),
      });
    }
    return map;
  }

  async capacity(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipIds: readonly string[],
  ): Promise<ReadonlyMap<string, CapacityRow>> {
    const map = new Map<string, CapacityRow>();
    if (membershipIds.length === 0) return map;
    const found = await rows<{
      membership_id: string;
      weekly_hours: number | string;
      effective_from: string;
    }>(runner, capacitySql(membershipIds.length), [context.organizationId, ...membershipIds]);
    for (const r of found) {
      map.set(r.membership_id, {
        weeklyHours: Number(r.weekly_hours),
        effectiveFrom: String(r.effective_from),
      });
    }
    return map;
  }

  /** Display names for the ids of one grouping; unknown ids are simply absent. */
  async names(
    runner: TenantQueryRunner,
    context: TenantContext,
    by: ProfitabilityGroup,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    const sqlOf =
      by === 'project' ? projectNamesSql : by === 'client' ? clientNamesSql : memberNamesSql;
    const map = new Map<string, string>();
    const wanted = [...new Set(ids.filter((id) => id !== ''))];
    for (let i = 0; i < wanted.length; i += NAME_CHUNK) {
      const chunk = wanted.slice(i, i + NAME_CHUNK);
      const found = await rows<{ id: string; name: string }>(runner, sqlOf(chunk.length), [
        context.organizationId,
        ...chunk,
      ]);
      for (const r of found) map.set(r.id, r.name);
    }
    return map;
  }
}
