import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type {
  ApprovalRow,
  ClientRequestRow,
  SavedContextEntityType,
  SavedContextRow,
  WorkItemRow,
} from '../../common/database/schema.js';
import { toWorkItemView } from '../work/work-items.service.js';
import type { WorkItemView } from '../work/work-items.service.js';
import { MyDayRepository } from './my-day.repository.js';
import { SavedContextRepository } from './saved-context.repository.js';
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

/**
 * The instant before which an item reads as overdue: the start of `now`'s calendar day (UTC, the
 * same day the Home pulse's "due today" counts). Due dates are whole days (the web stores a picked
 * day at noon UTC), so an item due today is "due today" until the day ends, never overdue — the
 * 2026-10-31 live test saw a today-due item labelled overdue next to a "1 due today" chip.
 */
export function overdueBefore(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** The My Day window for `now`: overdue before today, due soon up to the window's end. */
export function myDayWindow(now: Date): {
  readonly now: Date;
  readonly overdueBefore: Date;
  readonly dueSoonCutoff: Date;
} {
  return {
    now,
    overdueBefore: overdueBefore(now),
    dueSoonCutoff: new Date(now.getTime() + DUE_SOON_WINDOW_MS),
  };
}

function reasonFor(row: WorkItemRow, now: Date): MyDayReason {
  if (row.dueAt === null) return 'assigned';
  const due = row.dueAt.getTime();
  if (due < overdueBefore(now).getTime()) return 'overdue';
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
  /**
   * `approvals.version`, the optimistic-concurrency token the decision route requires: the phone's
   * inline Approve / Send back posts it back, so a decision made on a stale row is refused.
   */
  readonly version: number;
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
    version: row.version,
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

/**
 * HOME-05 saved/pinned context.
 *
 * A pin is a per-user, per-tenant *reference* to an entity the acting user keeps at hand on their
 * Home — a message, a deliverable version (`doc`), a work item, or a file — grouped by the project
 * it belongs to. The reference is stored and listed; resolving it to a live title/preview needs a
 * per-module read fan-out and is the deferred follow-up (NEXT-SCOPES-9), so a row carries only the
 * reference (`id` + `entityType` + `entityId`), never a copy of the entity.
 */

/** The command to pin an entity. The acting user is the session's, never a field on this. */
export interface PinContextCommand {
  readonly entityType: SavedContextEntityType;
  readonly entityId: string;
  /** The project the pin is grouped under; the entity must belong to it (see `pinContext`). */
  readonly projectId: string;
}

/**
 * HOME-05's response: the caller's pins grouped by project, deterministically ordered. Each entry
 * is inlined rather than a second exported shape, so the API↔web pairing is the one
 * {@link SavedContextView} projection — as `MyDayView`/`WaitingView` inline their entries. Dates are
 * ISO strings, the shape `JSON.stringify` emits on the wire.
 */
export interface SavedContextView {
  readonly groups: readonly {
    readonly projectId: string;
    readonly items: readonly {
      readonly id: string;
      readonly entityType: SavedContextEntityType;
      readonly entityId: string;
      readonly createdAt: string;
    }[];
  }[];
}

/**
 * Group already-ordered pin rows by project into the view's shape.
 *
 * Pure over its rows and order-preserving: the rows arrive ordered by `projectId` then oldest-first
 * then id (the repository's read), so a single pass yields groups in `projectId` order, each with
 * its items in that same stable order. Rows with a null `projectId` are excluded upstream (this
 * slice always sets it), so `projectId` is a string here.
 */
export function groupSavedContext(rows: readonly SavedContextRow[]): SavedContextView['groups'] {
  const groups: {
    projectId: string;
    items: {
      id: string;
      entityType: SavedContextEntityType;
      entityId: string;
      createdAt: string;
    }[];
  }[] = [];
  for (const row of rows) {
    if (row.projectId === null) continue;
    let group = groups.at(-1);
    if (!group || group.projectId !== row.projectId) {
      group = { projectId: row.projectId, items: [] };
      groups.push(group);
    }
    group.items.push({
      id: row.id,
      entityType: row.entityType,
      entityId: row.entityId,
      createdAt: row.createdAt.toISOString(),
    });
  }
  return groups;
}

export class HomeService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly myDay: MyDayRepository = new MyDayRepository(),
    private readonly waiting: WaitingRepository = new WaitingRepository(),
    private readonly savedContext: SavedContextRepository = new SavedContextRepository(),
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
    const window = myDayWindow(now);
    const rows = await this.database.read(context, (runner) =>
      this.myDay.listOwnedOpen(runner, context, principal.userId, window),
    );
    const readable = rows.filter((row) => this.mayRead(principal, row));
    // H2: the bounded read selects no `description`, so the card's view omits the field rather
    // than claiming the item has none (`WorkItemView.description` is optional for this reason).
    const items = rankMyDay(readable, context.correlationId, now).map(
      ({ reason, workItem: { description: _description, ...workItem } }) => ({ reason, workItem }),
    );
    return { items };
  }

  /**
   * H2: the personal-work counts over every open owned item — the list above is bounded, the
   * hero's numbers must not be. One grouped count, each group authorized by the same `work.read`
   * rule as a row (`mayRead` reads only the organization, project, audience and lifecycle; an open,
   * non-deleted item is always `active`).
   */
  private async personalWorkCounts(
    context: TenantContext,
    principal: Principal,
    now: Date,
  ): Promise<HomeSummaryView['personalWork']> {
    const window = myDayWindow(now);
    const groups = await this.database.read(context, (runner) =>
      this.myDay.countOwnedOpen(runner, context, principal.userId, window),
    );
    const counts = { total: 0, overdue: 0, dueSoon: 0 };
    for (const group of groups) {
      const allowed = this.mayReadResource(principal, {
        organizationId: context.organizationId,
        projectId: group.projectId,
        audience: group.audience,
        lifecycle: 'active',
      });
      if (!allowed) continue;
      counts.total += group.total;
      counts.overdue += group.overdue;
      counts.dueSoon += group.dueSoon;
    }
    return counts;
  }

  private mayRead(principal: Principal, row: WorkItemRow): boolean {
    return this.mayReadResource(principal, {
      organizationId: row.organizationId,
      projectId: row.projectId,
      audience: row.audience,
      lifecycle: row.deletedAt ? 'soft_deleted' : row.state === 'archived' ? 'archived' : 'active',
    });
  }

  private mayReadResource(
    principal: Principal,
    resource: {
      readonly organizationId: string;
      readonly projectId: string;
      readonly audience: WorkItemRow['audience'];
      readonly lifecycle: 'active' | 'archived' | 'soft_deleted';
    },
  ): boolean {
    return authorize({ principal, capability: 'work.read', resource }).allowed;
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
   * HOME-01's hero summary — the derived counts the hero shows. The waiting counts reuse
   * {@link waitingOf}'s ranked list; the personal-work counts are one grouped SQL count under the
   * same open-state predicate and the same per-row `work.read` rule as {@link myDayOf} (H2: that
   * list is bounded at `MY_DAY_LIMIT`, the counts cover every open item).
   */
  async summaryOf(
    context: TenantContext,
    principal: Principal,
    now: Date = new Date(),
  ): Promise<HomeSummaryView> {
    const [personalWork, waiting] = await Promise.all([
      this.personalWorkCounts(context, principal, now),
      this.waitingOf(context, principal, now),
    ]);

    const isClientWait = (entry: WaitingEntry): boolean =>
      entry.kind === 'client_request' && entry.reason !== 'stale_follow_up';

    return {
      personalWork,
      waiting: {
        total: waiting.items.length,
        approvals: waiting.items.filter((entry) => entry.kind === 'approval').length,
        clientRequests: waiting.items.filter(isClientWait).length,
        staleFollowUps: waiting.items.filter((entry) => entry.reason === 'stale_follow_up').length,
      },
    };
  }

  /**
   * HOME-05 — pin an entity to the acting user's saved context.
   *
   * The order is the whole of the tenant safety and follows the FAST-PROTOCOL "Known trap": the
   * project and the entity named by the command are **resolved tenant-scoped BEFORE** the
   * relation/authorize check, so a missing or cross-tenant `projectId`/`entityId` — including an
   * org-wide caller naming an id from another studio — is a **404 with no write**, never a 500 and
   * never a stored dangling reference. The entity must belong to the named project, so pinning it
   * beneath a foreign project is the same 404.
   *
   * The relation gate reuses `work.read` — the capability every Home read uses (the controller's
   * guard) — against the resolved project, so a pin can only reference an entity the caller can
   * already reach; a client principal has no `work.read` and is refused at the route. `audience` is
   * `internal` here: this is an internal Home feature, and the precise per-module audience is part
   * of the deferred read fan-out. The write is authorized object-layer as the acting user pinning to
   * their **own** set — `user_id` is `context.userId`, never a field — and is idempotent: a re-pin
   * of the same entity returns the existing set unchanged.
   */
  async pinContext(
    context: TenantContext,
    principal: Principal,
    command: PinContextCommand,
  ): Promise<SavedContextView> {
    await this.database.transaction(context, async (tx) => {
      // 1. Resolve tenant-scoped, BEFORE authorize (Known trap): unknown/cross-tenant → 404.
      if (!(await this.savedContext.projectExists(tx, context, command.projectId))) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound);
      }
      if (
        !(await this.savedContext.entityExistsInProject(
          tx,
          context,
          command.entityType,
          command.entityId,
          command.projectId,
        ))
      ) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound);
      }

      // 2. The relation gate — reused `work.read`, existence-hiding on denial (404, not 403).
      if (!this.mayReadProject(principal, command.projectId)) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound);
      }

      // 3. Own-user idempotent write.
      const existing = await this.savedContext.findPin(
        tx,
        context,
        context.userId,
        command.entityType,
        command.entityId,
      );
      if (!existing) {
        await this.savedContext.insert(tx, context, {
          userId: context.userId,
          entityType: command.entityType,
          entityId: command.entityId,
          projectId: command.projectId,
        });
      }
    });

    return this.listSavedContext(context, principal);
  }

  /**
   * HOME-05 — unpin. Own-user: the delete is scoped by `user_id = the acting user`, so an id that
   * names another user's pin (or no pin) removes nothing and answers 404. A pin is private, so this
   * hides the existence of one that is not the caller's rather than distinguishing it from absent.
   */
  async unpinContext(
    context: TenantContext,
    principal: Principal,
    savedContextId: string,
  ): Promise<SavedContextView> {
    const removed = await this.database.transaction(context, (tx) =>
      this.savedContext.deleteOwn(tx, context, context.userId, savedContextId),
    );
    if (!removed) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    return this.listSavedContext(context, principal);
  }

  /**
   * HOME-05 — the acting user's pins, grouped by project, deterministically ordered.
   *
   * Only the caller's own rows (`user_id`), each re-checked through the same `work.read` gate every
   * sibling read applies — belt-and-braces above the tenant-scoped SQL, so a pin to a project the
   * caller has since lost access to never appears even though the row is theirs. The rows arrive
   * ordered by project then oldest-first then id, so grouping in one pass keeps the order total.
   */
  async listSavedContext(context: TenantContext, principal: Principal): Promise<SavedContextView> {
    const rows = await this.database.read(context, (runner) =>
      this.savedContext.listForUser(runner, context, context.userId),
    );
    const visible = rows.filter(
      (row) => row.projectId !== null && this.mayReadProject(principal, row.projectId),
    );
    return { groups: groupSavedContext(visible) };
  }

  /**
   * The reused `work.read` relation gate against a project — the same `authorize()` `mayRead`
   * applies to a work row, here against the project a pin references. `audience: 'internal'` (see
   * `pinContext`); an org-wide role passes the relation by scope, a project member by membership,
   * anyone else is denied.
   */
  private mayReadProject(principal: Principal, projectId: string): boolean {
    return authorize({
      principal,
      capability: 'work.read',
      resource: {
        organizationId: principal.organizationId,
        projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
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
