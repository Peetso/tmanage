import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { MeetingRow } from '../../common/database/schema.js';
import { MeetingAgendaRepository } from './meeting-agenda.repository.js';
import { MeetingSeriesRepository } from './meeting-series.repository.js';
import { expandOccurrences } from './meeting-series.expand.js';

/**
 * CAL week/month grid (x212) — the read-only calendar grid over `meetings` (0029) and the
 * recurrence rules in `meeting_series` (0028/x129), behind `meeting.read`. No new table.
 *
 * The audit carried Calendar as *Partial*: x122 shipped a project meetings list and x127 a
 * date-bucketed agenda, but no week/month **grid** — a fixed window whose every day is a cell,
 * whether or not anything falls on it, so a screen can draw the empty days a calendar has. This
 * service composes that window: the concrete meetings whose start lands in it (the agenda read,
 * relation-filtered exactly as {@link MeetingAgendaController} filters), plus the recurrence
 * occurrences the tenant's series fall on inside it — expanded by the pure x129 helper
 * ({@link expandOccurrences}), never re-implemented here.
 *
 * ## Why this is a service and the agenda is not
 *
 * The agenda is one windowed read plus a grouping, so its logic lives on the controller. The grid
 * composes **two** reads (meetings and series) and an expansion with its own caps, so the
 * orchestration is lifted here where the controller test can exercise the bucketing, the relation
 * filter and the bounded expansion over fakes with the real `authorize()`. There is still no
 * transaction — both reads are read-only — so this opens none.
 *
 * ## Bounding the expansion (the Known-trap)
 *
 * A monthly grid of a daily series is ~31 occurrences for one series; a tenant with many series
 * could otherwise expand an unbounded set. Three caps hold it: the window itself is at most a
 * calendar month, the series read is a bounded page ({@link MAX_GRID_SERIES}), and the total
 * occurrences emitted are capped ({@link MAX_GRID_OCCURRENCES}) — the walk stops adding once the
 * ceiling is reached. `expandOccurrences` is itself total over a validated window, so no path loops.
 */

/** The two grid windows a caller may ask for; a runtime list so the service validates against it. */
export const CALENDAR_GRID_RANGES = ['week', 'month'] as const;
export type CalendarGridRange = (typeof CALENDAR_GRID_RANGES)[number];

/** A calendar day is a `YYYY-MM-DD` date-only string (the 0012 convention). */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;
/** A bounded page of concrete meetings — a month of a grid is not a whole-tenant export. */
const MAX_GRID_MEETINGS = 500;
/** A bounded page of recurrence rules to expand across the window. */
const MAX_GRID_SERIES = 200;
/** The ceiling on generated occurrences: a daily series over a month must not expand without bound. */
const MAX_GRID_OCCURRENCES = 500;

/** One concrete meeting in a day cell. Not exported: the paired shape is {@link CalendarGridView}. */
interface CalendarGridMeeting {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  /** An ISO-8601 instant on the wire. */
  readonly startsAt: string;
}

/** One recurrence occurrence in a day cell — a series' rule falling on this day, not a stored row. */
interface CalendarGridOccurrence {
  readonly seriesId: string;
  readonly title: string;
}

/** One grid cell: its `YYYY-MM-DD` day (UTC) and what falls on it. Emitted even when both are empty. */
interface CalendarGridDay {
  readonly date: string;
  readonly meetings: readonly CalendarGridMeeting[];
  readonly occurrences: readonly CalendarGridOccurrence[];
}

/**
 * The grid read's response — x212's `CalendarGridView`, paired Exact in
 * `e2e/contracts/api-web-shapes.ts` with the web shape `CalendarGridScreen` consumes (CONTRACT-001).
 * `organizationId` is absent (`25-AUTH…` §7): the tenant id is never echoed into a response body.
 * The window `[from, to]` is echoed so the screen lays out the same cells the response fills.
 */
export interface CalendarGridView {
  readonly range: CalendarGridRange;
  readonly anchor: string;
  readonly from: string;
  readonly to: string;
  readonly days: readonly CalendarGridDay[];
}

export interface CalendarGridInput {
  readonly range: unknown;
  readonly anchor: unknown;
}

export class CalendarGridService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly agenda: MeetingAgendaRepository = new MeetingAgendaRepository(),
    private readonly series: MeetingSeriesRepository = new MeetingSeriesRepository(),
  ) {}

  /**
   * The acting tenant's calendar grid for the week or month containing `anchor`.
   *
   * `range` must be `week` or `month` and `anchor` a `YYYY-MM-DD` day, or the whole read is a 400
   * before any query. The window is derived from them (the Monday-based week, or the calendar month)
   * and every day in it is returned as a cell — a grid draws empty days too. Concrete meetings are
   * relation-filtered so a caller sees only the meetings of projects they belong to; occurrences are
   * org-scoped (a series names no project) and gated by the `meeting.read` ceiling alone.
   */
  async grid(
    context: TenantContext,
    principal: Principal,
    input: CalendarGridInput,
  ): Promise<CalendarGridView> {
    const { range, anchor } = parseInput(input);

    const window = windowFor(range, anchor);
    const fromInclusive = new Date(`${window.from}T00:00:00.000Z`);
    const toExclusive = new Date(Date.parse(`${window.to}T00:00:00.000Z`) + MS_PER_DAY);

    const [meetingRows, seriesRows] = await this.database.read(context, async (runner) => {
      const meetings = await this.agenda.listInWindow(runner, context, {
        fromInclusive,
        toExclusive,
        limit: MAX_GRID_MEETINGS,
      });
      const series = await this.series.list(runner, context, { limit: MAX_GRID_SERIES });
      return [meetings, series] as const;
    });

    // Pre-seed every day in the window so the grid has a cell for each — including the empty ones.
    const byDay = new Map<
      string,
      { meetings: CalendarGridMeeting[]; occurrences: CalendarGridOccurrence[] }
    >();
    for (const date of eachDay(window.from, window.to)) {
      byDay.set(date, { meetings: [], occurrences: [] });
    }

    for (const row of meetingRows) {
      // Belt-and-braces to the tenant-scoped SQL: a cross-tenant row or a project the caller is not
      // a member of is dropped here, never a 403 — the day cell simply lacks it.
      if (!this.mayRead(principal, row)) continue;
      const cell = byDay.get(row.startsAt.toISOString().slice(0, 10));
      if (cell) cell.meetings.push(toMeeting(row));
    }

    let emitted = 0;
    for (const series of seriesRows) {
      if (emitted >= MAX_GRID_OCCURRENCES) break;
      const occurrences = expandOccurrences(
        {
          freq: series.freq,
          interval: series.interval,
          // The anchor is the series' creation date (its UTC calendar date), as x129 does.
          anchor: series.createdAt.toISOString().slice(0, 10),
          until: series.until,
        },
        window.from,
        window.to,
      );
      for (const date of occurrences) {
        if (emitted >= MAX_GRID_OCCURRENCES) break;
        const cell = byDay.get(date);
        if (cell) {
          cell.occurrences.push({ seriesId: series.id, title: series.title });
          emitted += 1;
        }
      }
    }

    const days: CalendarGridDay[] = eachDay(window.from, window.to).map((date) => {
      const cell = byDay.get(date) ?? { meetings: [], occurrences: [] };
      return { date, meetings: cell.meetings, occurrences: cell.occurrences };
    });

    return { range, anchor, from: window.from, to: window.to, days };
  }

  /** The relation rule, expressed with `work.read` (a ceiling-mirror of `meeting.read`, as x127). */
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
function toMeeting(row: MeetingRow): CalendarGridMeeting {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    startsAt: row.startsAt.toISOString(),
  };
}

/** Validate the query, throwing a 400 (before any read) rather than returning a partial grid. */
function parseInput(input: CalendarGridInput): { range: CalendarGridRange; anchor: string } {
  const details: { field: string; message: string }[] = [];
  const range = input.range;
  if (typeof range !== 'string' || !(CALENDAR_GRID_RANGES as readonly string[]).includes(range)) {
    details.push({ field: 'range', message: 'must be one of week, month' });
  }
  const anchor = input.anchor;
  if (
    typeof anchor !== 'string' ||
    !DATE_ONLY.test(anchor) ||
    Number.isNaN(Date.parse(`${anchor}T00:00:00.000Z`))
  ) {
    details.push({ field: 'anchor', message: 'must be a YYYY-MM-DD date' });
  }
  if (details.length > 0) {
    throw new ApiError(400, 'validation_failed', 'The grid request is invalid', details);
  }
  return { range: range as CalendarGridRange, anchor: anchor as string };
}

/** The `[from, to]` calendar window for a range around `anchor` — a Monday-based week, or the month. */
function windowFor(range: CalendarGridRange, anchor: string): { from: string; to: string } {
  const anchorMs = Date.parse(`${anchor}T00:00:00.000Z`);
  const date = new Date(anchorMs);
  if (range === 'week') {
    // getUTCDay: Sunday=0..Saturday=6; Monday index = (day + 6) % 7 so weeks start on Monday.
    const mondayOffset = (date.getUTCDay() + 6) % 7;
    const from = new Date(anchorMs - mondayOffset * MS_PER_DAY);
    const to = new Date(from.getTime() + 6 * MS_PER_DAY);
    return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
  }
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const first = new Date(Date.UTC(year, month, 1));
  const last = new Date(Date.UTC(year, month + 1, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

/** Every `YYYY-MM-DD` day in the inclusive window `[from, to]`, ascending. */
function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  for (let ms = start; ms <= end; ms += MS_PER_DAY) {
    out.push(new Date(ms).toISOString().slice(0, 10));
  }
  return out;
}
