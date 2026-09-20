import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ApprovalRow, ClientRequestRow, WorkItemRow } from '../../common/database/schema.js';
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
 * HOME-04 "Waiting" — the second vertical slice of Home / My Day, now over three buckets.
 *
 * x98 shipped the first bucket — **approvals pending on me as a reviewer**. This slice (x102-b)
 * adds the two remaining buckets that need no new column and slot into x98's discriminated `kind`
 * union without reshaping it:
 *
 * - **client-wait** (`kind: 'client_request'`) — open client requests awaiting the acting user's
 *   action: those in `submitted` (needs a first triage) or `triage` (needs a decision). Read
 *   read-only from `client_requests`, org-scoped, gated per row by the same `client_request.triage`
 *   relation the requests module's own reads enforce.
 * - **stale follow-up** (`kind: 'client_request'`, reason `'stale_follow_up'`) — a request in
 *   `needs_clarification` (waiting on the *client* to answer) that has sat there past
 *   {@link STALE_FOLLOW_UP_WINDOW_MS}, so the acting user should chase it. Derived from the
 *   existing `updated_at`, no new column. A *fresh* `needs_clarification` request is deliberately
 *   absent from every bucket: it is genuinely waiting on the client and needs no nudge yet.
 *
 * The **delegated** bucket (`41-...-MATRIX` HOME-04) is still deliberately absent, not stubbed:
 * `work_items` has a single `owner_user_id` and no creator/assignee column, so "work I delegated
 * elsewhere" is not representable and is a carried data-model item for scoping (Needs-Peter).
 *
 * It adds nothing to the approvals, requests or clients modules and edits neither `capabilities.ts`
 * nor the role grid: `client_request.triage`'s holders (owner, org_admin, workspace_admin, manager)
 * are all a subset of `approval.read`'s, so the controller's `approval.read` ceiling still admits
 * every reader of either bucket, and the real gate stays per row.
 */

/** Why an approval is on the Waiting list. See {@link WAITING_REASON_RANK} for the order. */
export type ApprovalWaitingReason = 'approval_requested' | 'approval_viewed';

/** Why a client request is on the Waiting list. See {@link WAITING_REASON_RANK} for the order. */
export type ClientWaitingReason = 'client_submitted' | 'client_triage' | 'stale_follow_up';

/** Every reason a row can be waiting, across the buckets. */
export type WaitingReason = ApprovalWaitingReason | ClientWaitingReason;

/**
 * The approvals bucket's row: an approval pending on the caller as a reviewer. Field-for-field as
 * x98 shipped it — the `kind: 'approval'` discriminant is what lets the client-request arm below
 * be an *added* arm rather than a reshape.
 *
 * Dates are ISO strings, the shape `JSON.stringify` emits on the wire.
 */
export interface ApprovalWaitingEntry {
  readonly kind: 'approval';
  readonly reason: ApprovalWaitingReason;
  readonly approvalId: string;
  readonly deliverableId: string;
  readonly projectId: string;
  /** When the review was requested — `approvals.created_at`, the "waiting since". */
  readonly requestedAt: string;
}

/**
 * The client-request bucket's row — client-wait and stale-follow-up both. `reason` says which:
 * `client_submitted`/`client_triage` are the client-wait bucket, `stale_follow_up` the stale one.
 * `waitingSince` is `client_requests.updated_at`, the instant the request entered its current
 * waiting state (equal to `created_at` for a fresh submission, since the submit writes both).
 */
export interface ClientRequestWaitingEntry {
  readonly kind: 'client_request';
  readonly reason: ClientWaitingReason;
  readonly clientRequestId: string;
  readonly projectId: string;
  /** The request's own title — the studio reads its subject, not a generic label. */
  readonly title: string;
  /** `client_requests.updated_at`, the instant it entered this waiting state. */
  readonly waitingSince: string;
}

/**
 * One Waiting row: a discriminated union over the buckets. A later bucket (e.g. `'delegated'`) is
 * one more arm, never a reshape of an existing one. Deliberately **not** suffixed `View`, so
 * CONTRACT-001 counts the one response projection — {@link WaitingView} — and the entry pairs with
 * the web client structurally through it, as `MyDayEntry` does.
 */
export type WaitingEntry = ApprovalWaitingEntry | ClientRequestWaitingEntry;

/** HOME-04's response: the acting user's waiting rows across the buckets, ranked. */
export interface WaitingView {
  readonly items: readonly WaitingEntry[];
}

/**
 * The order value each waiting reason sorts by. Smaller ranks higher on the list.
 *
 * The buckets group by what the caller can do about the row *now*. The two approval reasons and
 * the two client-wait reasons are all "waiting on **you** to act" — an untouched approval request
 * before one already opened, a new client request before one already in triage — so they lead.
 * `stale_follow_up` is "you have acted; you are waiting on the **client**, go nudge them" — a
 * lower-priority chase, so it trails. Within a reason the oldest row leads (see {@link rankWaiting}).
 */
const WAITING_REASON_RANK: Readonly<Record<WaitingReason, number>> = {
  approval_requested: 0,
  approval_viewed: 1,
  client_submitted: 2,
  client_triage: 3,
  stale_follow_up: 4,
};

/**
 * How long a `needs_clarification` request may sit before it reads as a stale follow-up. Seven
 * days: long enough that a client has plainly had a working week to answer, short enough that the
 * thread has not gone cold. A request younger than this is not on any bucket — it is genuinely
 * waiting on the client and needs no nudge. Mirrors {@link DUE_SOON_WINDOW_MS}'s house style.
 */
export const STALE_FOLLOW_UP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** `requested` and `viewed` are the only states {@link WaitingRepository.listPending} returns. */
function approvalWaitingReasonFor(row: ApprovalRow): ApprovalWaitingReason {
  return row.state === 'requested' ? 'approval_requested' : 'approval_viewed';
}

function toApprovalWaitingEntry(
  row: ApprovalRow,
  reason: ApprovalWaitingReason,
): ApprovalWaitingEntry {
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
 * The reason a client request is waiting, or `null` when it is on no bucket. `submitted` and
 * `triage` are the client-wait bucket; a `needs_clarification` request joins the stale bucket only
 * once it has aged past {@link STALE_FOLLOW_UP_WINDOW_MS}. Any other state (in progress or terminal)
 * is off the list. The clock enters only here, so the age test is provable over fakes.
 */
function clientWaitingReasonFor(row: ClientRequestRow, now: Date): ClientWaitingReason | null {
  switch (row.state) {
    case 'submitted':
      return 'client_submitted';
    case 'triage':
      return 'client_triage';
    case 'needs_clarification':
      return now.getTime() - row.updatedAt.getTime() >= STALE_FOLLOW_UP_WINDOW_MS
        ? 'stale_follow_up'
        : null;
    default:
      return null;
  }
}

function toClientRequestWaitingEntry(
  row: ClientRequestRow,
  reason: ClientWaitingReason,
): ClientRequestWaitingEntry {
  return {
    kind: 'client_request',
    reason,
    clientRequestId: row.id,
    projectId: row.projectId,
    title: row.title,
    waitingSince: row.updatedAt.toISOString(),
  };
}

/** The instant a built entry has been waiting since — its `requestedAt`/`waitingSince`. */
function waitingSinceOf(entry: WaitingEntry): number {
  return Date.parse(entry.kind === 'approval' ? entry.requestedAt : entry.waitingSince);
}

/** A built entry's id, for the stable tiebreak. */
function waitingIdOf(entry: WaitingEntry): string {
  return entry.kind === 'approval' ? entry.approvalId : entry.clientRequestId;
}

/**
 * Rank the caller's already-built waiting entries into one Waiting order across the buckets:
 * by {@link WAITING_REASON_RANK} first, then oldest-waiting first (the row kept waiting longest),
 * ties falling back to id so the order is total and stable.
 *
 * Pure over its entries — the clock was applied upstream when each entry's reason was decided — so
 * the ranking is provable over fakes.
 */
export function rankWaiting(entries: readonly WaitingEntry[]): readonly WaitingEntry[] {
  return [...entries].sort((a, b) => {
    if (WAITING_REASON_RANK[a.reason] !== WAITING_REASON_RANK[b.reason]) {
      return WAITING_REASON_RANK[a.reason] - WAITING_REASON_RANK[b.reason];
    }
    const at = waitingSinceOf(a);
    const bt = waitingSinceOf(b);
    if (at !== bt) return at - bt;
    return compareId(waitingIdOf(a), waitingIdOf(b));
  });
}

/**
 * HOME-01's hero summary — a pure aggregation over the two reads above, no new read table.
 *
 * Every count is derived from the actual ranked lists {@link HomeService.myDayOf} and
 * {@link HomeService.waitingOf} produce, so the hero can show no number the lists do not.
 */
export interface HomeSummaryView {
  readonly personalWork: {
    readonly total: number;
    readonly overdue: number;
    readonly dueSoon: number;
  };
  readonly waiting: {
    readonly total: number;
    readonly approvals: number;
    readonly clientRequests: number;
    readonly staleFollowUps: number;
  };
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
   * The acting user's Waiting section across the three buckets — approvals pending on them as a
   * reviewer, client requests awaiting their triage, and stale client follow-ups.
   *
   * One read of each tenant-scoped source, then the per-bucket real gate: for approvals, the
   * reviewer relation (AUTH-08) plus `approval.read`; for client requests, the same
   * `client_request.triage` relation the requests module enforces on its own reads. A row a caller
   * has no relation to never appears even though it is pending in their tenant. The client-request
   * reason (and so whether a `needs_clarification` row is a stale follow-up at all) is decided with
   * `now`, then all buckets are merged and ranked by {@link rankWaiting}.
   *
   * `now` is a parameter so the stale-age test can be exercised without waiting; the running
   * application takes the default.
   */
  async waitingOf(
    context: TenantContext,
    principal: Principal,
    now: Date = new Date(),
  ): Promise<WaitingView> {
    const { approvalRows, clientRows } = await this.database.read(context, async (runner) => ({
      approvalRows: await this.waiting.listPending(runner, context),
      clientRows: await this.waiting.listOpenClientRequests(runner, context),
    }));

    const approvals = approvalRows
      .filter(
        (row) => this.isAssignedReviewer(principal, row) && this.mayReadApproval(principal, row),
      )
      .map((row) => toApprovalWaitingEntry(row, approvalWaitingReasonFor(row)));

    const clientRequests = clientRows
      .filter((row) => this.mayTriageClientRequest(principal, row))
      .flatMap((row) => {
        const reason = clientWaitingReasonFor(row, now);
        return reason === null ? [] : [toClientRequestWaitingEntry(row, reason)];
      });

    return { items: rankWaiting([...approvals, ...clientRequests]) };
  }

  /**
   * HOME-01's hero summary — the derived counts the hero shows, aggregated purely from the two
   * reads above. Reuses {@link myDayOf} and {@link waitingOf} rather than re-querying, so every
   * count is a fact about the same ranked lists the sections render — the hero can invent no number.
   */
  async summaryOf(
    context: TenantContext,
    principal: Principal,
    now: Date = new Date(),
  ): Promise<HomeSummaryView> {
    const [myDay, waiting] = await Promise.all([
      this.myDayOf(context, principal, now),
      this.waitingOf(context, principal, now),
    ]);

    const isClientWait = (entry: WaitingEntry): boolean =>
      entry.kind === 'client_request' && entry.reason !== 'stale_follow_up';

    return {
      personalWork: {
        total: myDay.items.length,
        overdue: myDay.items.filter((entry) => entry.reason === 'overdue').length,
        dueSoon: myDay.items.filter((entry) => entry.reason === 'due_soon').length,
      },
      waiting: {
        total: waiting.items.length,
        approvals: waiting.items.filter((entry) => entry.kind === 'approval').length,
        clientRequests: waiting.items.filter(isClientWait).length,
        staleFollowUps: waiting.items.filter((entry) => entry.reason === 'stale_follow_up').length,
      },
    };
  }

  /**
   * The reviewer relation — the real gate (AUTH-08). The same predicate x92's decide flow feeds
   * to `authorize()`'s `isAssignedReviewer`: a user not in `reviewer_ids` never sees the approval.
   */
  private isAssignedReviewer(principal: Principal, row: ApprovalRow): boolean {
    return row.reviewerIds.includes(principal.userId);
  }

  /**
   * The client-request triage relation — the real gate, identical to `ClientRequestsService`'s own
   * `mayTriage`: `authorize()` under `client_request.triage` against the row's resource. A caller
   * with no triage relation to the row's project never sees it, exactly as the requests module's
   * list refuses it, so this read reveals nothing that module's read would not.
   *
   * `audience` mirrors `ClientRequestsService.audienceOf`: `needs_clarification` is
   * `client_action_required`, every other state `client_visible`.
   */
  private mayTriageClientRequest(principal: Principal, row: ClientRequestRow): boolean {
    return authorize({
      principal,
      capability: 'client_request.triage',
      resource: {
        organizationId: row.organizationId,
        projectId: row.projectId,
        audience: row.state === 'needs_clarification' ? 'client_action_required' : 'client_visible',
        clientOrganizationId: row.clientOrganizationId,
        lifecycle: 'active',
      },
    }).allowed;
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
