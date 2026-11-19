import { randomUUID } from 'node:crypto';
import type { WorkerDatabase } from './worker-database.js';
import type {
  ActorPeriod,
  ActorWeek,
  AiCostDay,
  AiTaskDay,
  ApprovalFact,
  GrowthRollupStore,
  OrgGrowthFacts,
  RollupRow,
  SubscriptionFact,
} from '../../jobs/growth-rollup.js';
import { REPORT_SENT_METRIC } from '../../jobs/growth-rollup.js';

/**
 * 57-14 — the growth rollup job's statements over the worker's pool (0284).
 *
 * Grants (users.sql, 0284 block): SELECT/INSERT/UPDATE/DELETE on `platform_growth_rollups`;
 * SELECT on `product_events`, `subscriptions`, `approvals`; `organizations`, `projects`,
 * `invitations`, `work_items`, `decisions`, `project_clients` and `platform_settings` were already
 * readable. Only ids, hashes, plan ids and timestamps are selected — never a title, a body, an
 * e-mail or a property other than the sign-up `source` slug (PRIV-06). Every bound is a bound JS
 * Date (the worker's clock), every read is capped.
 *
 * 62-A3 (B14) adds `client_invoices.issue_date` / `state` (already readable, 0301 worker block),
 * `projects.archived_at` / `status`, and two day aggregates: `ai_tasks` (counts by status) and
 * `ai_usage_ledger` (summed settled cost) — grouped in SQL, so no AI row id leaves the database.
 */

type Rows = readonly Record<string, unknown>[];

const ORG_CAP = 50_000;
const ACTOR_CAP = 500_000;
const SUBSCRIPTION_CAP = 100_000;
const APPROVAL_CAP = 200_000;
/** Days in the 13-month window plus the leading week, with room. */
const DAY_CAP = 500;
const UPSERT_CHUNK = 200;

export const SIGNUP_EVENT = 'signup_completed_v1';

export const GROWTH_SQL = {
  lastComputed: `select max(computed_at) as at from platform_growth_rollups`,
  organizations: `select o.id as id, o.created_at as created_at,
      (select json_unquote(json_extract(e.properties_json, '$.source')) from product_events e
        where e.organization_id = o.id and e.event_name = '${SIGNUP_EVENT}'
        order by e.occurred_at limit 1) as source,
      (select min(p.created_at) from projects p where p.organization_id = o.id) as first_project_at,
      (select count(*) from invitations i where i.organization_id = o.id
        and i.client_organization_id is null
        and i.created_at < date_add(o.created_at, interval 7 day)) as invites_7d,
      (select count(*) from work_items w where w.organization_id = o.id
        and w.created_at < date_add(o.created_at, interval 7 day)) as work_items_7d,
      (select count(*) from decisions d where d.organization_id = o.id
        and d.source_message_id is not null
        and d.created_at < date_add(o.created_at, interval 7 day)) as converted_7d,
      (select count(*) from work_items w where w.organization_id = o.id
        and w.completed_at is not null
        and w.completed_at < date_add(o.created_at, interval 7 day)) as completed_7d,
      (select min(pc.created_at) from project_clients pc
        where pc.organization_id = o.id) as client_linked_at,
      (select min(a.decided_at) from approvals a
        where a.organization_id = o.id and a.decided_at is not null) as approval_decided_at,
      (select min(coalesce(p.archived_at, p.updated_at)) from projects p
        where p.organization_id = o.id
          and (p.archived_at is not null or p.status = 'completed')) as first_project_finished_at,
      (select min(ci.issue_date) from client_invoices ci
        where ci.organization_id = o.id and ci.issue_date is not null
          and ci.state not in ('draft', 'void')) as first_invoice_issued_at
    from organizations o where o.created_at >= ? order by o.created_at limit ${String(ORG_CAP)}`,
  actorWeeks: `select e.organization_id as organization_id, e.actor_hash as actor_hash,
      date_format(date_sub(date(e.occurred_at), interval weekday(e.occurred_at) day), '%Y-%m-%d')
        as week_start
    from product_events e
    where e.occurred_at >= ? and e.actor_hash is not null and e.principal_kind = 'internal'
    group by e.organization_id, e.actor_hash, week_start
    limit ${String(ACTOR_CAP)}`,
  actorMonths: `select e.organization_id as organization_id, e.actor_hash as actor_hash,
      date_format(e.occurred_at, '%Y-%m-01') as month_start
    from product_events e
    where e.occurred_at >= ? and e.actor_hash is not null and e.principal_kind = 'internal'
    group by e.organization_id, e.actor_hash, month_start
    limit ${String(ACTOR_CAP)}`,
  companiesTotal: `select count(*) as total from organizations`,
  aiTaskDays: `select date_format(t.started_at, '%Y-%m-%d') as day, count(*) as run,
      sum(case when t.status = 'completed' then 1 else 0 end) as completed,
      sum(case when t.status = 'undone' then 1 else 0 end) as undone
    from ai_tasks t where t.started_at >= ?
    group by day order by day limit ${String(DAY_CAP)}`,
  aiCostDays: `select date_format(l.settled_at, '%Y-%m-%d') as day,
      sum(l.cost_micro_usd) as cost_micro_usd
    from ai_usage_ledger l where l.status = 'settled' and l.settled_at >= ?
    group by day order by day limit ${String(DAY_CAP)}`,
  subscriptions: `select plan_id, created_at from subscriptions
    where status in ('active', 'pending_change') limit ${String(SUBSCRIPTION_CAP)}`,
  approvals: `select created_at, decided_at from approvals
    where decided_at is not null and decided_at >= ? limit ${String(APPROVAL_CAP)}`,
  billingMode: `select setting_value from platform_settings where setting_key = 'billing_mode'`,
  upsert: (n: number) => `insert into platform_growth_rollups
      (id, period_kind, period_start, metric, dimension, value_num, sample_count, computed_at)
    values ${Array.from({ length: n }, () => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
    on duplicate key update value_num = values(value_num), sample_count = values(sample_count),
      computed_at = values(computed_at)`,
  deleteBefore: `delete from platform_growth_rollups where period_start < ?`,
  reportSent: `select 1 as sent from platform_growth_rollups
    where period_kind = 'month' and period_start = ? and metric = '${REPORT_SENT_METRIC}'
      and dimension = '' limit 1`,
} as const;

const num = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};
const date = (value: unknown): Date | null => {
  if (value instanceof Date) return value;
  if (typeof value !== 'string' || value === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};
const text = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

export function toOrgFacts(row: Record<string, unknown>): OrgGrowthFacts {
  return {
    key: String(row['id']),
    createdAt: date(row['created_at']) ?? new Date(0),
    source: text(row['source']),
    firstProjectAt: date(row['first_project_at']),
    internalInvites7d: num(row['invites_7d']),
    workItems7d: num(row['work_items_7d']),
    convertedMessages7d: num(row['converted_7d']),
    completedWork7d: num(row['completed_7d']),
    clientLinkedAt: date(row['client_linked_at']),
    approvalDecidedAt: date(row['approval_decided_at']),
    firstProjectFinishedAt: date(row['first_project_finished_at']),
    firstInvoiceIssuedAt: date(row['first_invoice_issued_at']),
  };
}

export function createGrowthRollupStore(database: WorkerDatabase): GrowthRollupStore {
  const read = (sql: string, params: readonly unknown[] = []) =>
    database.read((tx) => tx.query<Rows>(sql, params));
  return {
    async lastComputedAt() {
      return date((await read(GROWTH_SQL.lastComputed))[0]?.['at']);
    },
    async organizations(since) {
      return (await read(GROWTH_SQL.organizations, [since])).map(toOrgFacts);
    },
    async actorWeeks(since): Promise<readonly ActorWeek[]> {
      return (await read(GROWTH_SQL.actorWeeks, [since])).map((r) => ({
        key: String(r['organization_id']),
        actorHash: String(r['actor_hash']),
        weekStart: String(r['week_start']),
      }));
    },
    async actorMonths(since): Promise<readonly ActorPeriod[]> {
      return (await read(GROWTH_SQL.actorMonths, [since])).map((r) => ({
        key: String(r['organization_id']),
        actorHash: String(r['actor_hash']),
        periodStart: String(r['month_start']),
      }));
    },
    async companiesTotal() {
      return num((await read(GROWTH_SQL.companiesTotal))[0]?.['total']);
    },
    async aiTaskDays(since): Promise<readonly AiTaskDay[]> {
      return (await read(GROWTH_SQL.aiTaskDays, [since])).map((r) => ({
        day: String(r['day']),
        run: num(r['run']),
        completed: num(r['completed']),
        undone: num(r['undone']),
      }));
    },
    async aiCostDays(since): Promise<readonly AiCostDay[]> {
      return (await read(GROWTH_SQL.aiCostDays, [since])).map((r) => ({
        day: String(r['day']),
        costMicroUsd: num(r['cost_micro_usd']),
      }));
    },
    async subscriptions(): Promise<readonly SubscriptionFact[]> {
      return (await read(GROWTH_SQL.subscriptions)).map((r) => ({
        planId: String(r['plan_id']),
        createdAt: date(r['created_at']) ?? new Date(0),
      }));
    },
    async approvals(since): Promise<readonly ApprovalFact[]> {
      return (await read(GROWTH_SQL.approvals, [since]))
        .map((r) => ({ createdAt: date(r['created_at']), decidedAt: date(r['decided_at']) }))
        .filter((r): r is ApprovalFact => r.createdAt !== null && r.decidedAt !== null);
    },
    async billingModeSetting() {
      return text((await read(GROWTH_SQL.billingMode))[0]?.['setting_value']);
    },
    async upsert(rows: readonly RollupRow[], computedAt: Date) {
      let written = 0;
      for (let at = 0; at < rows.length; at += UPSERT_CHUNK) {
        const chunk = rows.slice(at, at + UPSERT_CHUNK);
        const params = chunk.flatMap((r) => [
          randomUUID(),
          r.periodKind,
          r.periodStart,
          r.metric.slice(0, 48),
          r.dimension.slice(0, 64),
          r.value.toFixed(4),
          Math.max(0, Math.trunc(r.sampleCount)),
          computedAt,
        ]);
        await database.transaction((tx) => tx.query(GROWTH_SQL.upsert(chunk.length), params));
        written += chunk.length;
      }
      return written;
    },
    async deleteBefore(periodStart) {
      return database.transaction(async (tx) => {
        const result = await tx.query<{ affectedRows: number }>(GROWTH_SQL.deleteBefore, [
          periodStart,
        ]);
        return result.affectedRows;
      });
    },
    async reportSent(monthStart) {
      return (await read(GROWTH_SQL.reportSent, [monthStart])).length > 0;
    },
  };
}
