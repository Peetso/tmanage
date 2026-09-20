import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkItemRow } from '../../common/database/schema.js';
import { toWorkItemView } from '../work/work-items.service.js';
import type { WorkItemView } from '../work/work-items.service.js';
import { MyDayRepository } from './my-day.repository.js';

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

export class HomeService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly myDay: MyDayRepository = new MyDayRepository(),
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
}
