import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import type { MeetingRow, WorkItemRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { HomeService } from './home.service.js';
import { HomePulseRepository } from './home-pulse.repository.js';

/**
 * HOME-01's Focus summary — the acting user's headline counts, as one read.
 *
 * A pure count over three tenant-scoped reads, each already gated per row: the caller's own open
 * work (open-work + due-today), the tenant's meetings that start today (meetings-today), and the
 * Waiting reads {@link HomeService.waitingOf} produces (waiting-on-you). Every number is a fact
 * about rows the caller may actually read — the Focus capsule can show nothing a section would not.
 * Dates are compared as instants; the wire shape is four numbers.
 */
export interface HomePulseView {
  /** Open work the acting user owns in this tenant — the My Day open-state set. */
  readonly openWork: number;
  /** Of that open work, the items whose `dueAt` falls inside today (a subset of `openWork`). */
  readonly dueToday: number;
  /** Rows waiting on the acting user — the Waiting list total, gated per bucket. */
  readonly waitingOnYou: number;
  /** Meetings in this tenant that start today, that the acting user may read. */
  readonly meetingsToday: number;
}

/**
 * The half-open day window `[start, start + 24h)` that contains `now`, in UTC.
 *
 * "Today" is one deterministic calendar day so the same `now` always yields the same window,
 * which is what lets the counts be proven over fakes without a wall clock. UTC (not a per-user
 * zone) keeps it single-valued for this first slice; a zone-aware window is the follow-up once Home
 * carries the reader's zone. Half-open so a meeting or due date at exactly midnight belongs to one
 * day, never two.
 */
export function dayWindow(now: Date): { readonly from: Date; readonly to: Date } {
  const from = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  return { from, to };
}

function isWithin(instant: Date | null, from: Date, to: Date): boolean {
  if (instant === null) return false;
  const t = instant.getTime();
  return t >= from.getTime() && t < to.getTime();
}

export class HomePulseService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly pulse: HomePulseRepository = new HomePulseRepository(),
    private readonly home: HomeService = new HomeService(database),
  ) {}

  /**
   * The acting user's Focus summary.
   *
   * The order is the whole of the tenant + own-principal safety (FAST-PROTOCOL "Known trap"): the
   * work read is narrowed to `principal.userId`'s own rows and then authorized again with
   * `work.read`; the meetings read is tenant-scoped and each row is authorized with `work.read` over
   * its project — the same relation gate `MeetingsService.list` applies — so a meeting in a project
   * the caller cannot read (or a work item they have lost their relation to) never lifts a count.
   * The waiting count reuses {@link HomeService.waitingOf}, already gated per bucket, so the rule
   * lives in one place. A caller with no `work.read` at all (a client principal) counts nothing.
   *
   * `now` is a parameter so the day window and the reads can be exercised without a wall clock; the
   * running application takes the default.
   */
  async pulseOf(
    context: TenantContext,
    principal: Principal,
    now: Date = new Date(),
  ): Promise<HomePulseView> {
    const { from, to } = dayWindow(now);

    const { workRows, meetingRows } = await this.database.read(context, async (runner) => ({
      workRows: await this.pulse.listOwnedOpen(runner, context, principal.userId),
      meetingRows: await this.pulse.listMeetingsInWindow(runner, context, from, to),
    }));

    const readableWork = workRows.filter((row) => this.mayReadWork(principal, row));
    const meetingsToday = meetingRows.filter((row) => this.mayReadMeeting(principal, row)).length;
    const waiting = await this.home.waitingOf(context, principal, now);

    return {
      openWork: readableWork.length,
      dueToday: readableWork.filter((row) => isWithin(row.dueAt, from, to)).length,
      waitingOnYou: waiting.items.length,
      meetingsToday,
    };
  }

  private mayReadWork(principal: Principal, row: WorkItemRow): boolean {
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

  private mayReadMeeting(principal: Principal, row: MeetingRow): boolean {
    return authorize({
      principal,
      capability: 'work.read',
      resource: {
        organizationId: row.organizationId,
        projectId: row.projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
  }
}
