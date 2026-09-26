import type { ApiClient } from './client';

/**
 * CAL-01 / MTG-01 third slice (x108) — the meeting notes / decisions read.
 *
 * The read half of x105. A meeting's captured notes and decisions are served at
 * `GET .../meetings/:meetingId/notes` behind the same `meeting.read` capability as the meetings
 * list, in the server's deterministic order. There is no write here and no request body: the
 * only input is the meeting id in the path. Capture (the write side) and the decision
 * approval/lock lifecycle stay API-only until x105-b.
 *
 * The meeting is named by the path and resolved tenant-scoped before the relation check on the
 * API (x105's Known-trap order), so an unknown or cross-tenant meeting id is a 404 — the screen
 * shows a not-found state rather than an empty list that would confirm the meeting exists.
 */

/**
 * One captured note or decision, as the screen reads it. Paired `Exact` with the API's
 * `MeetingNoteView` in the contracts gate (`e2e/contracts/api-web-shapes.ts`): rename or retype a
 * field on either side and `pnpm contracts:check` fails.
 */
export interface MeetingNoteView {
  readonly id: string;
  readonly meetingId: string;
  /** `note` or `decision`. A decision is drawn distinctly from a plain note. */
  readonly kind: 'note' | 'decision';
  readonly body: string;
  readonly authorUserId: string;
  /** An ISO-8601 instant on the wire. */
  readonly createdAt: string;
}

export async function listMeetingNotes(
  client: ApiClient,
  organizationSlug: string,
  meetingId: string,
): Promise<{ readonly notes: readonly MeetingNoteView[] }> {
  const { data } = await client.request<{ readonly notes: readonly MeetingNoteView[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/meetings/${encodeURIComponent(meetingId)}/notes`,
  });
  return data;
}
