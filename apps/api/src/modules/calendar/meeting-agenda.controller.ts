import { Controller, Get, Inject, Query } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { MeetingRow } from '../../common/database/schema.js';
import { MeetingAgendaRepository } from './meeting-agenda.repository.js';

/**
 * CAL agenda / day view (x127) — the read-only agenda over `meetings` (0029), behind
 * `meeting.read`.
 *
 * The audit carried Calendar as *Partial*: x122 shipped a per-project meetings list, but no
 * date-bucketed agenda. This slice adds `GET .../meetings/agenda?from&to` — the acting tenant's
 * meetings grouped by the day they start on, across a bounded window a caller chooses.
 *
 * ## Why the logic lives here and not in a service
 *
 * The agenda adds no table, no write and no transaction: it is a windowed tenant read
 * ({@link MeetingAgendaRepository}) plus the same relation filter {@link MeetingsService.list}
 * applies, then a grouping. There is nothing for a service transaction boundary to own, so the
 * read composes directly here — the controller test exercises the grouping, the window clamp and
 * the relation filter with the real `authorize()`.
 *
 * ## The two authorization layers
 *
 * `CapabilityGuard` on the route asks the coarse `meeting.read` question — does this role's ceiling
 * include reading meetings at all — and refuses a caller without it (403) before this handler runs.
 * This handler adds the **relation** filter with each row's project in hand: an internal member
 * without organization-wide scope sees only the meetings of the projects they belong to. As in
 * {@link MeetingsService}, that relation check is expressed with the sibling `work.read` capability
 * (declared a ceiling-mirror of `meeting.read`, so equal by construction), which is what
 * `authorize()` already relation-gates. A dropped row is simply absent from the agenda — never a
 * 403 — so a non-member can tell neither which meetings exist nor which they are barred from.
 */

/** A calendar range is bounded by `YYYY-MM-DD` date-only strings; the day is the agenda bucket. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** The window is clamped: an agenda is a window in time, not an unbounded scan (max one month + a day). */
const MAX_WINDOW_DAYS = 31;
/** A bounded page over the window — an agenda is not a whole-tenant export. */
const MAX_AGENDA_MEETINGS = 500;
const MS_PER_DAY = 86_400_000;

/** One meeting on the agenda. No `View` suffix — the paired shape is {@link MeetingAgendaView}. */
interface MeetingAgendaEntry {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  /** An ISO-8601 instant on the wire. */
  readonly startsAt: string;
  readonly agendaNote: string | null;
  readonly createdByUserId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One day cell: the `YYYY-MM-DD` day (UTC) and the meetings that start on it, in start order. */
interface MeetingAgendaDay {
  readonly date: string;
  readonly meetings: readonly MeetingAgendaEntry[];
}

/** The requested range, echoed so the screen can lay out the window the response only fills. */
interface MeetingAgendaRange {
  readonly from: string;
  readonly to: string;
}

/**
 * The agenda read's response — x127's `MeetingAgendaView`, paired Exact in
 * `e2e/contracts/api-web-shapes.ts` with the web shape `MeetingAgendaScreen` consumes
 * (CONTRACT-001). `organizationId` is absent: the caller already knows which organization they
 * asked about, and the tenant id is never echoed into a response body (`25-AUTH…` §7).
 */
export interface MeetingAgendaView {
  readonly range: MeetingAgendaRange;
  readonly days: readonly MeetingAgendaDay[];
}

@Controller('v1/organizations/:orgSlug/meetings')
export class MeetingAgendaController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    private readonly agenda: MeetingAgendaRepository,
  ) {}

  /**
   * The acting tenant's meetings grouped by their start day, over a required, clamped window.
   *
   * `from`/`to` are required `YYYY-MM-DD` days, both ends inclusive; `to` must be on or after
   * `from`, and the window may span at most {@link MAX_WINDOW_DAYS} days — an over-wide window is a
   * 400, not a scan. Only days that carry at least one readable meeting are emitted, ascending;
   * within a day the meetings are in start order (the repository's order).
   */
  @Get('agenda')
  @RequireCapability('meeting.read')
  async agendaView(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<MeetingAgendaView> {
    const details: { field: string; message: string }[] = [];
    const parsedFrom = parseDay('from', from, details);
    const parsedTo = parseDay('to', to, details);
    if (parsedFrom && parsedTo && parsedFrom > parsedTo) {
      details.push({ field: 'to', message: 'must be on or after from' });
    }
    if (parsedFrom && parsedTo && parsedFrom <= parsedTo && windowDays(parsedFrom, parsedTo) > MAX_WINDOW_DAYS) {
      details.push({ field: 'to', message: `the window must span ${MAX_WINDOW_DAYS} days or fewer` });
    }
    if (details.length > 0 || !parsedFrom || !parsedTo) {
      throw new ApiError(400, 'validation_failed', 'The date range is invalid', details);
    }

    const fromInclusive = new Date(`${parsedFrom}T00:00:00.000Z`);
    // Exclusive upper bound: the start of the day *after* `to`, so the whole of `to` is included.
    const toExclusive = new Date(Date.parse(`${parsedTo}T00:00:00.000Z`) + MS_PER_DAY);

    const rows = await this.database.read(context, (runner) =>
      this.agenda.listInWindow(runner, context, {
        fromInclusive,
        toExclusive,
        limit: MAX_AGENDA_MEETINGS,
      }),
    );

    const byDay = new Map<string, MeetingAgendaEntry[]>();
    for (const row of rows) {
      // The relation filter, belt-and-braces to the tenant-scoped SQL: a cross-tenant row (never
      // fetched by the scoped query) or a project the caller is not a member of is dropped here.
      if (!this.mayRead(principal, row)) continue;

      const day = row.startsAt.toISOString().slice(0, 10);
      const cell = byDay.get(day) ?? [];
      cell.push(toEntry(row));
      byDay.set(day, cell);
    }

    const days: MeetingAgendaDay[] = [...byDay.keys()]
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map((date) => ({ date, meetings: byDay.get(date) ?? [] }));

    return { range: { from: parsedFrom, to: parsedTo }, days };
  }

  /** The relation rule, expressed with `work.read` (a ceiling-mirror of `meeting.read`). */
  private mayRead(principal: Principal, row: MeetingRow): boolean {
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

/** An explicit projection, not a serialised row (`25-AUTH…` §7): `organization_id` is never echoed. */
function toEntry(row: MeetingRow): MeetingAgendaEntry {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    startsAt: row.startsAt.toISOString(),
    agendaNote: row.agendaNote,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Validate a `YYYY-MM-DD` query value, adding a field error rather than throwing on a bad one. */
function parseDay(
  field: string,
  raw: unknown,
  details: { field: string; message: string }[],
): string | undefined {
  if (
    typeof raw !== 'string' ||
    !DATE_ONLY.test(raw) ||
    Number.isNaN(Date.parse(`${raw}T00:00:00Z`))
  ) {
    details.push({ field, message: 'must be a YYYY-MM-DD date' });
    return undefined;
  }
  return raw;
}

/** Inclusive day count of a `YYYY-MM-DD` window: `from`..`to` inclusive is `diff + 1` days. */
function windowDays(from: string, to: string): number {
  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toMs = Date.parse(`${to}T00:00:00.000Z`);
  return Math.round((toMs - fromMs) / MS_PER_DAY) + 1;
}
