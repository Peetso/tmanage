import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ApprovalRow, WorkItemRow } from '../../common/database/schema.js';
import { toWorkItemView } from '../work/work-items.service.js';
import type { WorkItemView } from '../work/work-items.service.js';
import { MyDayRepository } from './my-day.repository.js';
import { WaitingRepository } from './waiting.repository.js';

/**
 * HOME-03 "Personal work" — the first vertical slice of Home / My Day.
 *
 * The read returns the acting user's own open work across every project, each row carrying the
 * single reason it needs them today, ranked for a My-Day list. It reuses the `work.read`
 * capability (the controller's guard) and the work module's `WorkItemView` projection; it adds
 * nothing to the work module and edits neither `capabilities.ts` nor the role grid.
 */

/**
 * Why an item is on the My Day list. The order below is the list's rank order: an overdue item
 * outranks a due-soon one, which outranks one merely assigned.
 */
export type MyDayReason = 'overdue' | 'due_soon' | 'assigned';

/**
 * One personal-work row: the work item and the single reason it needs the acting user today.
 *
 * Deliberately **not** suffixed `View`, so the CONTRACT-001 enumeration counts the one response
 * projection here — {@link MyDayView} — rather than two. The entry still pairs with the web
 * client structurally through that one view.
 */
export interface MyDayEntry {
  readonly reason: MyDayReason;
  readonly workItem: WorkItemView;
}

/** HOME-03's response: the acting user's open work, ranked for My Day. */
export interface MyDayView {
  readonly items: readonly MyDayEntry[];
}

/**
 * How near its due date an item must be to read as `due_soon` rather than merely `assigned`.
 * Three days: near enough to be "this needs you soon", far enough that a fortnight-away task
 * does not crowd the list. An item due beyond this window, or with no due date at all, is
 * `assigned` — on the list because it is the caller's, not because a date is pressing.
 */
export const DUE_SOON_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/** The order value each reason sorts by. Smaller ranks higher on the list. */
const REASON_RANK: Readonly<Record<MyDayReason, number>> = {
  overdue: 0,
  due_soon: 1,
  assigned: 2,
};

function reasonFor(row: WorkItemRow, now: Date): MyDayReason {
  if (row.dueAt === null) return 'assigned';
  const due = row.dueAt.getTime();
  if (due < now.getTime()) return 'overdue';
  if (due <= now.getTime() + DUE_SOON_WINDOW_MS) return 'due_soon';
  // Dated, but far enough off that it is not pressing today.
  return 'assigned';
}

function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Rank a set of the caller's rows into My-Day order: overdue first, then due-soon, then the
 * rest. Within the two dated groups the soonest `due_at` leads (an overdue item's `due_at` is
 * in the past, so "soonest" is "most overdue"); the assigned group, which has no pressing date,
 * orders by id. Ties inside a dated group fall back to id, so the order is total and stable.
 *
 * Pure over its inputs — no clock, no database — so the ranking is provable over fakes.
 */
export function rankMyDay(
  rows: readonly WorkItemRow[],
  correlationId: string,
  now: Date,
): readonly MyDayEntry[] {
  const withReason = rows.map((row) => ({ row, reason: reasonFor(row, now) }));

  withReason.sort((a, b) => {
    if (REASON_RANK[a.reason] !== REASON_RANK[b.reason]) {
      return REASON_RANK[a.reason] - REASON_RANK[b.reason];
    }
    if (a.reason === 'assigned') return compareId(a.row.id, b.row.id);
    const at = a.row.dueAt?.getTime() ?? 0;
    const bt = b.row.dueAt?.getTime() ?? 0;
    if (at !== bt) return at - bt;
    return compareId(a.row.id, b.row.id);
  });

  return withReason.map(({ row, reason }) => ({
    reason,
    workItem: toWorkItemView(row, correlationId),
  }));
}

/**
 * HOME-04 "Waiting" — the second vertical slice of Home / My Day.
 *
 * This slice ships the one load-bearing bucket that is readable today: **approvals pending on me
 * as a reviewer**. The read returns the acting user's pending approvals across every project, each
 * carrying the single reason it is waiting on them, ranked for a Waiting list. It reuses the
 * `approval.read` capability (the controller's coarse guard) and the reviewer relation as the real
 * gate (AUTH-08); it adds nothing to the approvals module and edits neither `capabilities.ts` nor
 * the role grid.
 *
 * The **delegated** bucket (`41-...-MATRIX` HOME-04) is deliberately absent, not stubbed: the
 * `work_items` table has a single `owner_user_id` and no creator/assignee column, so "work I
 * delegated elsewhere" is not representable and is a data-model item for scoping. The shape is
 * kept extensible — a discriminated `kind` on every entry — so a second bucket slots in without a
 * breaking change.
 */

/**
 * Why an approval is on the Waiting list. The order below is the list's rank order: an approval
 * the reviewer has not yet opened (`requested`) outranks one they have opened but not decided
 * (`viewed`) — an untouched request needs a first look before one already in hand.
 */
export type WaitingReason = 'approval_requested' | 'approval_viewed';

/**
 * One Waiting row. `kind` is a discriminant so a later bucket (e.g. `'delegated'`, carrying a
 * work item rather than an approval) is an added arm, never a reshape of this one. Deliberately
 * **not** suffixed `View`, so CONTRACT-001 counts the one response projection — {@link WaitingView}
 * — and the entry pairs with the web client structurally through it, as `MyDayEntry` does.
 *
 * Dates are ISO strings, the shape `JSON.stringify` emits on the wire.
 */
export interface WaitingEntry {
  readonly kind: 'approval';
  readonly reason: WaitingReason;
  readonly approvalId: string;
  readonly deliverableId: string;
  readonly projectId: string;
  /** When the review was requested — `approvals.created_at`, the "waiting since". */
  readonly requestedAt: string;
}

/** HOME-04's response: the acting user's pending approvals, ranked for Waiting. */
export interface WaitingView {
  readonly items: readonly WaitingEntry[];
}

/** The order value each waiting reason sorts by. Smaller ranks higher on the list. */
const WAITING_REASON_RANK: Readonly<Record<WaitingReason, number>> = {
  approval_requested: 0,
  approval_viewed: 1,
};

/** `requested` and `viewed` are the only states {@link WaitingRepository.listPending} returns. */
function waitingReasonFor(row: ApprovalRow): WaitingReason {
  return row.state === 'requested' ? 'approval_requested' : 'approval_viewed';
}

function toWaitingEntry(row: ApprovalRow, reason: WaitingReason): WaitingEntry {
  return {
    kind: 'approval',
    reason,
    approvalId: row.id,
    deliverableId: row.deliverableId,
    projectId: row.projectId,
    requestedAt: row.createdAt.toISOString(),
  };
}

/**
 * Rank a set of the caller's pending approvals into Waiting order: not-yet-opened (`requested`)
 * first, then opened-not-decided (`viewed`); within a group the oldest request leads (the one
 * kept waiting longest), ties falling back to id so the order is total and stable.
 *
 * Pure over its rows — no clock, no database — so the ranking is provable over fakes. Unlike My
 * Day the reason is the approval's own lifecycle state, not a function of `now`, so no clock is
 * taken here.
 */
export function rankWaiting(rows: readonly ApprovalRow[]): readonly WaitingEntry[] {
  const withReason = rows.map((row) => ({ row, reason: waitingReasonFor(row) }));

  withReason.sort((a, b) => {
    if (WAITING_REASON_RANK[a.reason] !== WAITING_REASON_RANK[b.reason]) {
      return WAITING_REASON_RANK[a.reason] - WAITING_REASON_RANK[b.reason];
    }
    const at = a.row.createdAt.getTime();
    const bt = b.row.createdAt.getTime();
    if (at !== bt) return at - bt;
    return compareId(a.row.id, b.row.id);
  });

  return withReason.map(({ row, reason }) => toWaitingEntry(row, reason));
}

export class HomeService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly myDay: MyDayRepository = new MyDayRepository(),
    private readonly waiting: WaitingRepository = new WaitingRepository(),
  ) {}

  /**
   * The acting user's My Day personal-work section.
   *
   * `now` is a parameter so the ranking can be exercised without waiting for a date; the
   * running application takes the default. Each row is authorized again through the same
   * `work.read` rule every sibling read applies — belt-and-braces to the tenant-scoped SQL, so
   * an item the caller has lost their relation to never appears even though they own it.
   */
  async myDayOf(
    context: TenantContext,
    principal: Principal,
    now: Date = new Date(),
  ): Promise<MyDayView> {
    const rows = await this.database.read(context, (runner) =>
      this.myDay.listOwnedOpen(runner, context, principal.userId),
    );
    const readable = rows.filter((row) => this.mayRead(principal, row));
    return { items: rankMyDay(readable, context.correlationId, now) };
  }

  private mayRead(principal: Principal, row: WorkItemRow): boolean {
    return authorize({
      principal,
      capability: 'work.read',
      resource: {
        organizationId: row.organizationId,
        projectId: row.projectId,
        audience: row.audience,
        lifecycle: row.deletedAt
          ? ('soft_deleted' as const)
          : row.state === 'archived'
            ? ('archived' as const)
            : ('active' as const),
      },
    }).allowed;
  }

  /**
   * The acting user's Waiting section — the approvals pending on them as a reviewer.
   *
   * The tenant-scoped SQL narrows to this org's pending approvals; this then keeps only the ones
   * the caller is an assigned reviewer of (the real gate, AUTH-08) and may read, so an approval a
   * caller is not a reviewer of never appears even though it is pending in their tenant. Ranked
   * for the Waiting list by {@link rankWaiting}.
   */
  async waitingOf(context: TenantContext, principal: Principal): Promise<WaitingView> {
    const rows = await this.database.read(context, (runner) =>
      this.waiting.listPending(runner, context),
    );
    const mine = rows.filter(
      (row) => this.isAssignedReviewer(principal, row) && this.mayReadApproval(principal, row),
    );
    return { items: rankWaiting(mine) };
  }

  /**
   * The reviewer relation — the real gate (AUTH-08). The same predicate x92's decide flow feeds
   * to `authorize()`'s `isAssignedReviewer`: a user not in `reviewer_ids` never sees the approval.
   */
  private isAssignedReviewer(principal: Principal, row: ApprovalRow): boolean {
    return row.reviewerIds.includes(principal.userId);
  }

  /**
   * Belt-and-braces above the tenant-scoped SQL and the reviewer filter, exactly as `mayRead`
   * guards the My Day rows: the same `authorize()` every sibling read applies, so a caller who has
   * lost project access never sees the approval even while still named a reviewer on it.
   */
  private mayReadApproval(principal: Principal, row: ApprovalRow): boolean {
    return authorize({
      principal,
      capability: 'approval.read',
      resource: {
        organizationId: row.organizationId,
        projectId: row.projectId,
        audience: 'client_visible',
        lifecycle: 'active',
      },
    }).allowed;
  }
}
