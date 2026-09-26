import type { ApiClient } from './client';

/**
 * CAL agenda / day view (x127) — the read-only meeting agenda.
 *
 * A read-only composition the API serves at `GET .../meetings/agenda?from&to`, behind the same
 * `meeting.read` capability as the meetings list. Unlike the per-project list, the agenda is
 * tenant-wide: it returns every meeting the caller may read whose start falls in the requested
 * window, grouped by the day it starts on. The only inputs are the required `from`/`to` days in the
 * query — there is no body and no project id.
 */

/**
 * One meeting on the agenda. Not exported: the contracts gate enumerates every exported response
 * shape in this folder, and the agenda is a single paired response (`MeetingAgendaView`). The
 * screen reaches a day and its meetings through indexed access, not a second projection.
 */
interface MeetingAgendaEntry {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  /** An ISO-8601 instant on the wire. */
  readonly startsAt: string;
  /** The agenda note, or `null` when none was given. */
  readonly agendaNote: string | null;
  readonly createdByUserId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One day cell: its `YYYY-MM-DD` day (UTC) and the meetings that start on it. Not exported (see above). */
interface MeetingAgendaDay {
  readonly date: string;
  readonly meetings: readonly MeetingAgendaEntry[];
}

/** The requested range, echoed by the API. Not exported (see above). */
interface MeetingAgendaRange {
  readonly from: string;
  readonly to: string;
}

/** The agenda read's response — paired Exact with the API's `MeetingAgendaView` in the contracts gate. */
export interface MeetingAgendaView {
  readonly range: MeetingAgendaRange;
  readonly days: readonly MeetingAgendaDay[];
}

/** One agenda day, for the screen — an indexed access, so it is not a second enumerated shape. */
export type MeetingAgendaDayRow = MeetingAgendaView['days'][number];

export interface MeetingAgendaRangeInput {
  readonly from: string;
  readonly to: string;
}

export async function getMeetingAgenda(
  client: ApiClient,
  organizationSlug: string,
  range: MeetingAgendaRangeInput,
): Promise<MeetingAgendaView> {
  const parameters = new URLSearchParams({ from: range.from, to: range.to });
  const { data } = await client.request<MeetingAgendaView>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/meetings/agenda?${parameters.toString()}`,
  });
  return data;
}
