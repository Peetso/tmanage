import { and, asc, eq, gt } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { approvals } from '../../common/database/schema.js';
import type { ApprovalRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * INS-02's read seam — the approval-cycle roll-up.
 *
 * The counterpart to INS-01's delivery flow (x89): where that counts a project's work items by
 * workflow status, this rolls a project's approvals up by *outcome* — the terminal decisions
 * `approved`, `changes_requested`, `invalidated` (`23-ERD-AND-STATE-MACHINES` §8) — and, for the
 * decided ones, the requested→decided duration. It is the audit's "dashboards for … approval
 * cycles" read, and nothing more: a pure read, computed on demand, no column, no write, no
 * schedule, no migration.
 *
 * ## Read-only over `approvals` data
 *
 * x92 owns the `approvals` table and its decision writes. Its `ApprovalsRepository` exposes no
 * list read, so — as x89 gave insights its own `WorkItemsRepository` handle rather than import
 * `WorkModule` — this module owns its own read-only handle on `approvals` through
 * {@link InsightsApprovalsReader}. That reader is nothing but a tenant-scoped, project-filtered,
 * keyset-paginated `SELECT`; it never edits the approvals module and adds no column of its own.
 *
 * ## Tenancy is enforced twice, and the count is exact
 *
 * {@link InsightsApprovalsReader.list} scopes every page to `context.organizationId` in SQL, so a
 * cross-tenant approval is never returned in production. The {@link ApprovalCycleOptions.keep}
 * predicate is the service's per-row authorization (its `approval.read` relation check) applied
 * belt-and-braces on top of that scope, exactly as INS-01 applies `mayRead` to each listed work
 * item — so a row the caller may not read never contributes. Every project approval is visited,
 * page by page, because a count that stops early is a wrong count, not a short one.
 */

/** The terminal outcomes this read rolls up — the decided end-states, in report order. */
export const APPROVAL_CYCLE_OUTCOMES = ['approved', 'changes_requested', 'invalidated'] as const;

export type ApprovalCycleOutcome = (typeof APPROVAL_CYCLE_OUTCOMES)[number];

/** Whether a persisted `state` is one of the outcomes this read counts. */
export function isApprovalCycleOutcome(state: string): state is ApprovalCycleOutcome {
  return (APPROVAL_CYCLE_OUTCOMES as readonly string[]).includes(state);
}

/**
 * One outcome's tally. `count` is every readable approval in the outcome; `decidedCount` is those
 * of them that carry a `decided_at` and so contribute a duration; `totalDurationMs` sums the
 * requested→decided spans of exactly those. Sum-and-count rather than an average, because the sum
 * is exact integer milliseconds — a consumer derives the mean as `totalDurationMs / decidedCount`
 * and there is no rounding baked into the read. An `invalidated` row records no decision time
 * (§8: invalidation needs only a reason), so it counts but adds no duration — `decidedCount` is
 * how a consumer tells "no approvals" from "approvals with no measured duration" apart.
 */
export interface ApprovalOutcomeMetric {
  readonly count: number;
  readonly decidedCount: number;
  readonly totalDurationMs: number;
}

/** One metric per outcome, every outcome present (all zero when none). */
export type ApprovalCycleMetrics = Record<ApprovalCycleOutcome, ApprovalOutcomeMetric>;

export interface ApprovalCycleRollup {
  readonly metrics: ApprovalCycleMetrics;
  /** The readable approvals counted across every outcome — the sum of the outcome counts. */
  readonly approvalCount: number;
}

export interface ApprovalCycleOptions {
  /**
   * A per-row filter the service supplies — its principal-level authorization. A row for which
   * this returns `false` is skipped and does not contribute. Omitted, every row is kept.
   */
  readonly keep?: (row: ApprovalRow) => boolean;
}

/** Keyset page size for the approvals walk — the same 200 the work read uses. */
export const APPROVAL_CYCLE_PAGE_SIZE = 200;

export interface ApprovalCycleListOptions {
  readonly projectId: string;
  /** Keyset cursor: return rows whose id sorts strictly after this one. */
  readonly after?: string;
  readonly limit: number;
}

/** The read this roll-up walks — a page of a project's approvals, id-ordered. */
export interface ApprovalCycleReader {
  list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: ApprovalCycleListOptions,
  ): Promise<readonly ApprovalRow[]>;
}

/** The documented empty value: every outcome present, all zero. */
export function emptyApprovalCycleMetrics(): ApprovalCycleMetrics {
  const metrics = {} as ApprovalCycleMetrics;
  for (const outcome of APPROVAL_CYCLE_OUTCOMES) {
    metrics[outcome] = { count: 0, decidedCount: 0, totalDurationMs: 0 };
  }
  return metrics;
}

/**
 * Insights' own read-only handle on `approvals` — a tenant-scoped, project-filtered, id-keyset
 * `SELECT`, and nothing else. It mirrors `WorkItemsRepository.listQuery`'s shape exactly: the
 * tenant comes from the context and never the input, `id` orders the walk, and `after` is a
 * strict `>` so a page never re-counts its own last row.
 */
export class InsightsApprovalsReader implements ApprovalCycleReader {
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: ApprovalCycleListOptions,
  ): Promise<readonly ApprovalRow[]> {
    const predicates = [
      eq(approvals.organizationId, context.organizationId),
      eq(approvals.projectId, options.projectId),
    ];
    if (options.after) predicates.push(gt(approvals.id, options.after));

    return tenantDrizzle(runner)
      .select()
      .from(approvals)
      .where(and(...predicates))
      .orderBy(asc(approvals.id))
      .limit(options.limit);
  }
}

export class ApprovalCycleRepository {
  constructor(private readonly approvalsReader: ApprovalCycleReader) {}

  /**
   * Roll a project's readable approvals up by outcome, with the decided ones' durations.
   *
   * The walk is {@link ApprovalCycleReader.list}'s: id-ordered pages, each row kept only if
   * {@link ApprovalCycleOptions.keep} allows it, until a short page ends the project. A row whose
   * persisted `state` is not one of the tracked outcomes (a still-pending `requested`/`viewed`, or
   * a `cancelled`/`expired` end) is legitimately not part of an *outcome* roll-up and is skipped;
   * an outcome row's duration is added only when it carries a `decided_at`.
   */
  async approvalCycle(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    options: ApprovalCycleOptions = {},
  ): Promise<ApprovalCycleRollup> {
    const keep = options.keep ?? (() => true);
    const metrics = emptyApprovalCycleMetrics();
    let approvalCount = 0;
    let after: string | undefined;

    for (;;) {
      const page = await this.approvalsReader.list(runner, context, {
        projectId,
        ...(after === undefined ? {} : { after }),
        limit: APPROVAL_CYCLE_PAGE_SIZE,
      });

      for (const row of page) {
        if (!keep(row)) continue;
        if (!isApprovalCycleOutcome(row.state)) continue;

        const metric = metrics[row.state];
        const decidedAt = row.decidedAt;
        metrics[row.state] = {
          count: metric.count + 1,
          decidedCount: metric.decidedCount + (decidedAt !== null ? 1 : 0),
          totalDurationMs:
            metric.totalDurationMs +
            (decidedAt !== null ? durationMs(row.createdAt, decidedAt) : 0),
        };
        approvalCount += 1;
      }

      const last = page[page.length - 1];
      if (page.length < APPROVAL_CYCLE_PAGE_SIZE || last === undefined) break;
      after = last.id;
    }

    return { metrics, approvalCount };
  }
}

/**
 * Requested→decided span in whole milliseconds, never negative. `created_at` is the request time:
 * x92 persists an approval straight at `requested`, so the row's creation *is* the moment it was
 * asked for. A clock skew that would make `decided_at` precede it is clamped to zero rather than
 * reported as a negative duration.
 */
function durationMs(createdAt: Date, decidedAt: Date): number {
  return Math.max(0, decidedAt.getTime() - createdAt.getTime());
}
