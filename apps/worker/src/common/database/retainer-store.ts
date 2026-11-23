import { assertSafeAuditMetadata, localDateOf, uuidv7 } from '@tmanage/domain';
import {
  RETAINER_PERIOD_CLOSED_NOTICE,
  decideRetainerRoll,
} from '../../jobs/retainer-period-roll.js';
import type {
  OpenRetainerPeriod,
  RetainerPeriodKind,
  RetainerStore,
} from '../../jobs/retainer-period-roll.js';
import { insertNotification } from './notifications-store.js';
import { findOrganizationTimeZone } from './organization-clock-store.js';
import type { WorkerDatabase, WorkerTransaction } from './worker-database.js';

/**
 * 52-06 (0299) — the SQL behind `jobs/retainer-period-roll.ts`, as `tmanage_worker`: SELECT on
 * `retainers`, `retainer_projects`, `work_item_time_logs`, `organizations`; SELECT, INSERT, UPDATE on
 * `retainer_periods`; INSERT on `notifications` and `audit_events`. The used figure is the API's
 * (`retainers.repository.ts` `usedMinutes`): every minute logged on a covered project with
 * `spent_on` inside the period.
 */

// The cross-tenant reads: which open periods may be due / need a refresh. Every later statement
// names the period's own organization. `UTC_DATE() + 1` is a superset for zones ahead of UTC; the
// roll re-checks the organization's own today.
const LIST_DUE = `SELECT p.organization_id, p.retainer_id, p.id
  FROM retainer_periods p
  JOIN retainers r ON r.organization_id = p.organization_id AND r.id = p.retainer_id
 WHERE p.state = 'open' AND r.state <> 'paused' AND p.period_end < UTC_DATE() + INTERVAL 1 DAY
 ORDER BY p.period_end, p.id
 LIMIT ?`;

const LIST_OPEN = `SELECT organization_id, retainer_id, id
  FROM retainer_periods
 WHERE state = 'open' AND id > ?
 ORDER BY id
 LIMIT ?`;

const LOCK_RETAINER = `SELECT state, period, starts_on, ends_on, hours_per_period, rollover,
       rollover_cap_minutes, created_by
  FROM retainers
 WHERE organization_id = ? AND id = ?
 FOR UPDATE`;

const READ_PERIOD = `SELECT period_start, period_end, allowance_minutes, rollover_in_minutes, state
  FROM retainer_periods
 WHERE organization_id = ? AND id = ?
 FOR UPDATE`;

const SUM_USED = `SELECT COALESCE(SUM(minutes), 0) AS used
  FROM work_item_time_logs
 WHERE organization_id = ?
   AND project_id IN (SELECT project_id FROM retainer_projects
                       WHERE organization_id = ? AND retainer_id = ?)
   AND spent_on BETWEEN ? AND ? AND counted = 1`;

// The caches are frozen here: a closed period is never recomputed (a 52-03 lock included).
const CLOSE_PERIOD = `UPDATE retainer_periods
   SET state = 'closed', used_minutes_cache = ?, overage_minutes_cache = ?, closed_at = NOW(3)
 WHERE organization_id = ? AND id = ? AND state = 'open'`;

// The (organization_id, retainer_id, period_start) key makes a second opener a no-op.
const OPEN_PERIOD = `INSERT INTO retainer_periods
   (id, organization_id, retainer_id, period_start, period_end, allowance_minutes,
    rollover_in_minutes, used_minutes_cache, overage_minutes_cache, state, invoice_id, closed_at)
 VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 'open', NULL, NULL)
 ON DUPLICATE KEY UPDATE id = id`;

const REFRESH_CACHE = `UPDATE retainer_periods
   SET used_minutes_cache = ?, overage_minutes_cache = GREATEST(0, ? - allowance_minutes - rollover_in_minutes)
 WHERE organization_id = ? AND id = ? AND state = 'open'`;

const INSERT_AUDIT = `INSERT INTO audit_events
   (id, organization_id, actor_user_id, effective_actor_id, action, object_type, object_id,
    result, correlation_id, metadata_json, created_at)
 VALUES (?, ?, NULL, NULL, 'retainer.period_closed', 'retainer', ?, 'allowed', ?, ?, NOW(3))`;

interface RetainerRow {
  readonly state: string;
  readonly period: string;
  readonly starts_on: string | Date;
  readonly ends_on: string | Date | null;
  readonly hours_per_period: number | null;
  readonly rollover: string;
  readonly rollover_cap_minutes: number | null;
  readonly created_by: string;
}

interface PeriodRow {
  readonly period_start: string | Date;
  readonly period_end: string | Date;
  readonly allowance_minutes: number;
  readonly rollover_in_minutes: number;
  readonly state: string;
}

/** A DATE column as `YYYY-MM-DD`, whether the driver hands back a string or a Date. */
function day(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

async function usedMinutes(
  tx: WorkerTransaction,
  period: OpenRetainerPeriod,
  from: string,
  to: string,
): Promise<number> {
  const rows = await tx.query<readonly { readonly used: number | string }[]>(SUM_USED, [
    period.organizationId,
    period.organizationId,
    period.retainerId,
    from,
    to,
  ]);
  return Number(rows[0]?.used ?? 0);
}

/** One period: close it if due in the org's time zone, open the next. True when it closed. */
export async function rollOnePeriod(
  tx: WorkerTransaction,
  period: OpenRetainerPeriod,
  now: Date = new Date(),
): Promise<boolean> {
  const org = period.organizationId;
  const retainer = (
    await tx.query<readonly RetainerRow[]>(LOCK_RETAINER, [org, period.retainerId])
  )[0];
  const open = (await tx.query<readonly PeriodRow[]>(READ_PERIOD, [org, period.periodId]))[0];
  // Another pass closed it first (it waited on the retainer lock): nothing to do.
  if (retainer === undefined || open === undefined || open.state !== 'open') return false;
  const periodStart = day(open.period_start);
  const periodEnd = day(open.period_end);
  const used = await usedMinutes(tx, period, periodStart, periodEnd);
  const decision = decideRetainerRoll({
    state: retainer.state,
    period: (retainer.period === 'quarterly' ? 'quarterly' : 'monthly') as RetainerPeriodKind,
    startsOn: day(retainer.starts_on),
    endsOn: retainer.ends_on === null ? null : day(retainer.ends_on),
    hoursPerPeriod: retainer.hours_per_period === null ? null : Number(retainer.hours_per_period),
    rollover: retainer.rollover,
    rolloverCapMinutes:
      retainer.rollover_cap_minutes === null ? null : Number(retainer.rollover_cap_minutes),
    periodStart,
    periodEnd,
    allowanceMinutes: Number(open.allowance_minutes),
    rolloverInMinutes: Number(open.rollover_in_minutes),
    usedMinutes: used,
    today: localDateOf(now, await findOrganizationTimeZone(tx, org)),
  });
  if (!decision.close) return false;

  await tx.query(CLOSE_PERIOD, [used, decision.overageMinutes, org, period.periodId]);
  if (decision.next !== null) {
    await tx.query(OPEN_PERIOD, [
      uuidv7(),
      org,
      period.retainerId,
      decision.next.periodStart,
      decision.next.periodEnd,
      decision.next.allowanceMinutes,
      decision.next.rolloverInMinutes,
    ]);
  }
  const metadata = {
    retainer_period_id: period.periodId,
    used_minutes: used,
    overage_minutes: decision.overageMinutes,
    rollover_in_minutes: decision.next?.rolloverInMinutes ?? 0,
    next_opened: decision.next !== null,
  };
  assertSafeAuditMetadata(metadata);
  await tx.query(INSERT_AUDIT, [
    uuidv7(),
    org,
    period.retainerId,
    uuidv7(),
    JSON.stringify(metadata),
  ]);
  await insertNotification(tx, {
    organizationId: org,
    recipientUserId: retainer.created_by,
    type: RETAINER_PERIOD_CLOSED_NOTICE,
    objectType: 'retainer',
    objectId: period.retainerId,
    dedupeKey: `${RETAINER_PERIOD_CLOSED_NOTICE}:${period.periodId}`,
  });
  return true;
}

interface ListedRow {
  readonly organization_id: string;
  readonly retainer_id: string;
  readonly id: string;
}

const listed = (rows: readonly ListedRow[]): readonly OpenRetainerPeriod[] =>
  rows.map((r) => ({
    organizationId: r.organization_id,
    retainerId: r.retainer_id,
    periodId: r.id,
  }));

export function createRetainerStore(database: WorkerDatabase): RetainerStore {
  return {
    listDue: (limit) =>
      database.read(async (tx) =>
        listed(await tx.query<readonly ListedRow[]>(LIST_DUE, [Math.max(1, Math.trunc(limit))])),
      ),
    rollPeriod: (period) => database.transaction((tx) => rollOnePeriod(tx, period)),
    listOpen: (after, limit) =>
      database.read(async (tx) =>
        listed(
          await tx.query<readonly ListedRow[]>(LIST_OPEN, [
            after ?? '',
            Math.max(1, Math.trunc(limit)),
          ]),
        ),
      ),
    refreshPeriod: (period) =>
      database.transaction(async (tx) => {
        const open = (
          await tx.query<readonly PeriodRow[]>(READ_PERIOD, [
            period.organizationId,
            period.periodId,
          ])
        )[0];
        if (open === undefined || open.state !== 'open') return;
        const used = await usedMinutes(tx, period, day(open.period_start), day(open.period_end));
        await tx.query(REFRESH_CACHE, [used, used, period.organizationId, period.periodId]);
      }),
  };
}
