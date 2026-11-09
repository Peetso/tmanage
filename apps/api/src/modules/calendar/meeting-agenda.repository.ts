import { and, asc, eq, gte, isNull, lt } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { meetings } from '../../common/database/schema.js';
import type { MeetingRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The meeting-agenda repository — CAL agenda / day view (x127).
 *
 * Unlike {@link MeetingsRepository.list}, which lists **one project's** meetings, the agenda is a
 * tenant-wide window: it reads every meeting in the acting tenant whose `starts_at` falls inside a
 * bounded `[from, to)` instant range, ordered by start time. The controller then drops the rows
 * the principal may not read (its relation filter) and buckets the rest by day — the read here is
 * the tenant scope and the window, nothing more.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally, exactly as
 * {@link MeetingsRepository} honours it: the first two parameters are the `TenantQueryRunner` and
 * the `TenantContext` (there is no unscoped overload), the tenant comes from the context and never
 * a DTO, and the `organization_id` predicate is on the statement.
 */

/**
 * Injection token for {@link MeetingAgendaRepository}. Following the same convention as the other
 * tenant controllers (e.g. `MEMBERSHIPS_REPOSITORY`), the controller injects the repository through
 * a token and holds it only as a type, so its import is a pure `import type`. The token is
 * slice-local (declared beside the class it provides) to keep this slice file-disjoint from the
 * shared `common/http/tokens.ts` append point.
 */
export const MEETING_AGENDA_REPOSITORY = Symbol('MEETING_AGENDA_REPOSITORY');

export interface MeetingAgendaWindow {
  /** Inclusive lower bound on `starts_at` — the start of the first requested day, in UTC. */
  readonly fromInclusive: Date;
  /** Exclusive upper bound on `starts_at` — the start of the day *after* the last requested day. */
  readonly toExclusive: Date;
  /** A bounded page: an agenda over at most a month of meetings is not an unbounded export. */
  readonly limit: number;
}

export class MeetingAgendaRepository {
  /**
   * List the acting tenant's meetings whose start falls in the half-open window `[fromInclusive,
   * toExclusive)`, ordered by start time then id.
   *
   * Both bounds are on `starts_at`; the `organization_id` predicate is the tenant scope. The order
   * is `(starts_at, id)` so the walk is chronological and ties break deterministically — the
   * controller relies on the within-day order being the server's, not a client re-sort.
   */
  async listInWindow(
    runner: TenantQueryRunner,
    context: TenantContext,
    window: MeetingAgendaWindow,
  ): Promise<readonly MeetingRow[]> {
    const db = tenantDrizzle(runner);

    return db
      .select()
      .from(meetings)
      .where(
        and(
          eq(meetings.organizationId, context.organizationId),
          gte(meetings.startsAt, window.fromInclusive),
          lt(meetings.startsAt, window.toExclusive),
          // PA-03 (0245): a soft-deleted meeting leaves the list.
          isNull(meetings.deletedAt),
          // FIX2 (live 2026-11-09): a cancelled meeting leaves the calendar grid, the agenda and
          // the day capsule above My Day; its page still opens by id for the record.
          isNull(meetings.cancelledAt),
        ),
      )
      .orderBy(asc(meetings.startsAt), asc(meetings.id))
      .limit(window.limit);
  }
}
