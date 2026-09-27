import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { WorkItemRecurrenceRow, WorkItemRow } from '../../common/database/schema.js';
import { WORK_ITEM_RECURRENCE_FREQS } from '../../common/database/schema.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import { WorkItemRecurrenceRepository } from './item-recurrence.repository.js';

/**
 * x257's application service — a work item's recurrence rule (Work module 7).
 *
 * The two rules that matter live here, the way the sibling sub-resources place them:
 *
 * ## Resolve the item, tenant-scoped, BEFORE authorizing or writing
 *
 * Every route names a `workItemId` in the path; the parent work item is read first, scoped to the
 * acting tenant — a cross-tenant `work_item_id` simply does not resolve, and the answer is the same
 * 404 an absent id gives, before `authorize()` is ever asked and before any write.
 *
 * ## Generation is pure and does not itself create work
 *
 * `generateNext` computes the next occurrence from {@link computeNextOccurrence} — a pure function
 * over the rule and a bound `Date` (never the database clock; see the admin-pool-clock trap) — and
 * returns the computed occurrence payload only. It writes no new work item: creating the next item
 * stays in `work.service`, which keeps this slice file-disjoint.
 */

const MIN_INTERVAL = 1;
const MAX_INTERVAL = 365;

/** The client-facing projection of a recurrence rule. Paired in `apps/web`. */
export interface WorkItemRecurrenceView {
  readonly workItemId: string;
  readonly freq: string;
  readonly interval: number;
  readonly until: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The computed next occurrence — what `generate-next` returns; it is not persisted. */
export interface NextOccurrenceView {
  readonly workItemId: string;
  readonly freq: string;
  readonly interval: number;
  /** The instant the computation started from (the bound clock). */
  readonly from: string;
  /** The next occurrence, or `null` when the rule is exhausted (past its `until` bound). */
  readonly nextAt: string | null;
  readonly exhausted: boolean;
}

export interface SetRecurrenceInput {
  readonly freq: string;
  readonly interval: number;
  readonly until?: string | null;
}

/**
 * Compute the next occurrence strictly after `from`, or `null` when the rule is exhausted.
 *
 * A pure function of the rule and a bound clock — no I/O, no ambient `Date.now()` — so the cadence
 * arithmetic is provable in isolation. `daily` advances whole days, `weekly` advances weeks,
 * `monthly` advances calendar months (a day-of-month past the target month's length lands on the
 * last day of that month, the way month arithmetic clamps). When the rule carries an `until` bound
 * and the computed instant falls after it, the rule has ended and the result is `null`.
 */
export function computeNextOccurrence(
  rule: { readonly freq: string; readonly intervalCount: number; readonly untilAt: Date | null },
  from: Date,
): Date | null {
  const interval = rule.intervalCount;
  const next = new Date(from.getTime());
  switch (rule.freq) {
    case 'daily':
      next.setUTCDate(next.getUTCDate() + interval);
      break;
    case 'weekly':
      next.setUTCDate(next.getUTCDate() + interval * 7);
      break;
    case 'monthly': {
      const day = next.getUTCDate();
      // Move to the first of the target month, then clamp the day to that month's length.
      next.setUTCDate(1);
      next.setUTCMonth(next.getUTCMonth() + interval);
      const lastDay = new Date(
        Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
      ).getUTCDate();
      next.setUTCDate(Math.min(day, lastDay));
      break;
    }
    default:
      // Unreachable: freq is validated against the allowlist before it reaches here.
      return null;
  }
  if (rule.untilAt !== null && next.getTime() > rule.untilAt.getTime()) return null;
  return next;
}

export class WorkItemRecurrenceService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly workItems: WorkItemsRepository,
    private readonly recurrence: WorkItemRecurrenceRepository = new WorkItemRecurrenceRepository(),
  ) {}

  /** The recurrence rule for a work item, or `null` if it does not recur. Behind `work.read`. */
  async get(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
  ): Promise<WorkItemRecurrenceView | null> {
    return this.database.read(context, async (runner) => {
      await this.readableParent(runner, context, principal, workItemId);
      const row = await this.recurrence.findByItem(runner, context, workItemId);
      return row ? toView(row) : null;
    });
  }

  /** Set (upsert) the recurrence rule. Behind `work.update`. Bad freq / interval / until → 400. */
  async set(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    input: SetRecurrenceInput,
  ): Promise<WorkItemRecurrenceView> {
    const freq = requiredFreq(input.freq);
    const intervalCount = requiredInterval(input.interval);
    const untilAt = optionalUntil(input.until);
    return this.database.transaction(context, async (tx) => {
      const parent = await this.readableParent(tx, context, principal, workItemId);
      this.requireWrite(principal, parent);
      const row = await this.recurrence.upsert(tx, context, workItemId, {
        freq,
        intervalCount,
        untilAt,
      });
      return toView(row);
    });
  }

  /** Clear the recurrence rule. Behind `work.update`. A no-op 204 when the item did not recur. */
  async clear(context: TenantContext, principal: Principal, workItemId: string): Promise<void> {
    await this.database.transaction(context, async (tx) => {
      const parent = await this.readableParent(tx, context, principal, workItemId);
      this.requireWrite(principal, parent);
      await this.recurrence.deleteByItem(tx, context, workItemId);
    });
  }

  /**
   * Compute the next occurrence from the rule over a bound clock. Behind `work.update`. Returns the
   * computed occurrence payload only — it writes no work item. A 404 when the item does not recur.
   */
  async generateNext(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    now: Date,
  ): Promise<NextOccurrenceView> {
    return this.database.transaction(context, async (tx) => {
      const parent = await this.readableParent(tx, context, principal, workItemId);
      this.requireWrite(principal, parent);
      const row = await this.recurrence.findByItem(tx, context, workItemId);
      if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      const nextAt = computeNextOccurrence(
        { freq: row.freq, intervalCount: row.intervalCount, untilAt: row.untilAt },
        now,
      );
      return {
        workItemId,
        freq: row.freq,
        interval: row.intervalCount,
        from: now.toISOString(),
        nextAt: nextAt ? nextAt.toISOString() : null,
        exhausted: nextAt === null,
      };
    });
  }

  /**
   * Read the parent work item, tenant-scoped, and refuse a caller who may not read it. The 404 for
   * "no relation" is produced here, before any write, and is the same 404 the work-item read
   * produces for a row that does not exist.
   */
  private async readableParent(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    workItemId: string,
  ): Promise<WorkItemRow> {
    const row = await this.workItems.findById(runner, context, workItemId);
    if (!row || row.deletedAt !== null || !this.mayRead(principal, row)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    return row;
  }

  private requireWrite(principal: Principal, parent: WorkItemRow): void {
    const verdict = authorize({
      principal,
      capability: 'work.update',
      resource: resourceOf(parent),
    });
    if (!verdict.allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, verdict.code);
    }
  }

  private mayRead(principal: Principal, row: WorkItemRow): boolean {
    return authorize({ principal, capability: 'work.read', resource: resourceOf(row) }).allowed;
  }
}

function resourceOf(row: WorkItemRow) {
  return {
    organizationId: row.organizationId,
    projectId: row.projectId,
    audience: row.audience,
    lifecycle: row.deletedAt
      ? ('soft_deleted' as const)
      : row.state === 'archived'
        ? ('archived' as const)
        : ('active' as const),
  };
}

function toView(row: WorkItemRecurrenceRow): WorkItemRecurrenceView {
  return {
    workItemId: row.workItemId,
    freq: row.freq,
    interval: row.intervalCount,
    until: row.untilAt ? row.untilAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function requiredFreq(raw: unknown): string {
  if (typeof raw !== 'string' || !(WORK_ITEM_RECURRENCE_FREQS as readonly string[]).includes(raw)) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'freq', message: `must be one of: ${WORK_ITEM_RECURRENCE_FREQS.join(', ')}` },
    ]);
  }
  return raw;
}

function requiredInterval(raw: unknown): number {
  if (
    typeof raw !== 'number' ||
    !Number.isInteger(raw) ||
    raw < MIN_INTERVAL ||
    raw > MAX_INTERVAL
  ) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      {
        field: 'interval',
        message: `must be an integer between ${MIN_INTERVAL} and ${MAX_INTERVAL}`,
      },
    ]);
  }
  return raw;
}

function optionalUntil(raw: unknown): Date | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'until', message: 'must be an ISO-8601 date-time string' },
    ]);
  }
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'until', message: 'must be an ISO-8601 date-time string' },
    ]);
  }
  return at;
}
