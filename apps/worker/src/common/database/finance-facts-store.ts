import { mergeFinanceFacts, uuidv7 } from '@tmanage/domain';
import type { ExpenseFactInput, FinanceFact, TimeFactInput } from '@tmanage/domain';
import type { FinanceFactsStore } from '../../jobs/finance-facts-rebuild.js';
import type { WorkerDatabase, WorkerTransaction } from './worker-database.js';

/**
 * 52-14 (0296) — the SQL behind `jobs/finance-facts-rebuild.ts`, as `tmanage_worker`: SELECT,
 * INSERT, DELETE on `finance_daily_facts`; SELECT on `work_item_time_logs`, `expenses`,
 * `projects`, `project_clients`, `org_finance_profiles`. `logged_by` is the membership id.
 *
 * The rebuild statements are copied verbatim from the API's
 * `apps/api/src/modules/insights/finance-reports.repository.ts` (one app may not import another's
 * `src/`; the budget-burn pair does the same). Change both together. The fold itself is the shared
 * pure `mergeFinanceFacts` in `@tmanage/domain`, so only the reads are duplicated.
 */

// ── Copied from finance-reports.repository.ts ───────────────────────────────

const TIME_FACTS_SQL = `SELECT DATE_FORMAT(l.spent_on, '%Y-%m-%d') AS day,
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
 WHERE l.organization_id = ? AND l.spent_on BETWEEN ? AND ? AND l.counted = 1
 GROUP BY l.spent_on, l.project_id, l.logged_by`;

const EXPENSE_FACTS_SQL = `SELECT DATE_FORMAT(e.spent_on, '%Y-%m-%d') AS day,
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

const PROJECT_CLIENTS_SQL = `SELECT pc.project_id, pc.client_organization_id
  FROM project_clients pc
 WHERE pc.organization_id = ?
 ORDER BY pc.project_id, pc.created_at, pc.id`;

const BASE_CURRENCY_SQL = `SELECT fp.base_currency
  FROM org_finance_profiles fp
 WHERE fp.organization_id = ?
 LIMIT 1`;

const DELETE_FACTS_SQL = `DELETE FROM finance_daily_facts
 WHERE organization_id = ? AND day BETWEEN ? AND ?`;

const INSERT_FACTS_HEAD = `INSERT INTO finance_daily_facts
   (id, organization_id, day, project_id, client_organization_id, membership_id,
    billable_minutes, nonbillable_minutes, writeoff_minutes, unpriced_minutes,
    billed_minor, cost_minor, expense_minor, invoiced_minor, currency, computed_at)
 VALUES `;
const INSERT_FACTS_TUPLE = '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
const INSERT_FACTS_BATCH = 200;

// ── Worker only ─────────────────────────────────────────────────────────────

// The two cross-tenant reads: when the loop last ran, and which organizations have anything in
// the window (sources, or stale facts to clear). Every later statement names one organization.
const LAST_COMPUTED_SQL = `SELECT MAX(computed_at) AS last_computed FROM finance_daily_facts`;

const ORGANIZATIONS_SQL = `SELECT DISTINCT organization_id FROM work_item_time_logs
  WHERE spent_on BETWEEN ? AND ?
 UNION
 SELECT DISTINCT organization_id FROM expenses
  WHERE spent_on BETWEEN ? AND ? AND state IN ('approved', 'invoiced')
 UNION
 SELECT DISTINCT organization_id FROM finance_daily_facts
  WHERE day BETWEEN ? AND ?`;

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

const timeFactOf = (row: TimeFactDbRow): TimeFactInput => ({
  day: String(row.day),
  projectId: row.project_id,
  membershipId: row.membership_id,
  billableMinutes: Number(row.billable_minutes),
  nonbillableMinutes: Number(row.nonbillable_minutes),
  writeoffMinutes: Number(row.writeoff_minutes),
  unpricedMinutes: Number(row.unpriced_minutes),
  billedMinor: Number(row.billed_minor),
  costMinor: Number(row.cost_minor),
});

const expenseFactOf = (row: ExpenseFactDbRow): ExpenseFactInput => ({
  day: String(row.day),
  projectId: row.project_id,
  membershipId: row.membership_id,
  expenseMinor: Number(row.expense_minor),
});

const factValues = (org: string, fact: FinanceFact, at: Date): unknown[] => [
  uuidv7(),
  org,
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
  at,
];

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const at = value instanceof Date ? value : new Date(String(value).replace(' ', 'T') + 'Z');
  return Number.isNaN(at.getTime()) ? null : at;
}

/** One organization's window: read, fold, DELETE, INSERT. Inside the caller's transaction. */
export async function rebuildOrganizationFacts(
  tx: WorkerTransaction,
  org: string,
  from: string,
  to: string,
  computedAt: Date,
): Promise<number> {
  const time = await tx.query<readonly TimeFactDbRow[]>(TIME_FACTS_SQL, [org, from, to]);
  const expenses = await tx.query<readonly ExpenseFactDbRow[]>(EXPENSE_FACTS_SQL, [org, from, to]);
  const clients = await tx.query<
    readonly { readonly project_id: string; readonly client_organization_id: string }[]
  >(PROJECT_CLIENTS_SQL, [org]);
  const currency = await tx.query<readonly { readonly base_currency: string }[]>(
    BASE_CURRENCY_SQL,
    [org],
  );
  const clientByProject = new Map<string, string>();
  for (const row of clients) {
    if (!clientByProject.has(row.project_id)) {
      clientByProject.set(row.project_id, row.client_organization_id);
    }
  }
  const facts = mergeFinanceFacts({
    time: time.map(timeFactOf),
    expenses: expenses.map(expenseFactOf),
    clientByProject,
    currency: currency[0]?.base_currency ?? null,
  });
  await tx.query(DELETE_FACTS_SQL, [org, from, to]);
  for (let i = 0; i < facts.length; i += INSERT_FACTS_BATCH) {
    const batch = facts.slice(i, i + INSERT_FACTS_BATCH);
    await tx.query(
      INSERT_FACTS_HEAD + batch.map(() => INSERT_FACTS_TUPLE).join(', '),
      batch.flatMap((fact) => factValues(org, fact, computedAt)),
    );
  }
  return facts.length;
}

export function createFinanceFactsStore(database: WorkerDatabase): FinanceFactsStore {
  return {
    lastComputedAt: () =>
      database.read(async (tx) => {
        const rows =
          await tx.query<readonly { readonly last_computed: unknown }[]>(LAST_COMPUTED_SQL);
        return toDate(rows[0]?.last_computed);
      }),
    organizations: (from, to) =>
      database.read(async (tx) => {
        const rows = await tx.query<readonly { readonly organization_id: string }[]>(
          ORGANIZATIONS_SQL,
          [from, to, from, to, from, to],
        );
        return rows.map((r) => r.organization_id);
      }),
    rebuild: (org, from, to, computedAt) =>
      database.transaction((tx) => rebuildOrganizationFacts(tx, org, from, to, computedAt)),
  };
}
