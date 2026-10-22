import type { ApiClient } from './client';

/**
 * CAL-01 / MTG-01 (x90 API, x122 web) — the meeting list / create.
 *
 * A meeting is a tenant-scoped, project-scoped record served at `.../meetings`: `GET` lists one
 * project's meetings behind `meeting.read`, `POST` creates one behind `meeting.write`. The list
 * is per-project by definition — the API requires a `projectId` query parameter and never lists a
 * whole tenant's meetings — so the screen chooses a project and reads that project's meetings.
 */

/**
 * One meeting, as the screen reads it. Paired `Exact` with the API's `MeetingView` in the
 * contracts gate (`e2e/contracts/api-web-shapes.ts`): rename or retype a field on either side and
 * `pnpm contracts:check` fails. `organizationId` is deliberately absent — it is never echoed into
 * a response body (`25-AUTH-AND-TENANT-ISOLATION` §7).
 */
export interface MeetingView {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  /** An ISO-8601 instant on the wire. */
  readonly startsAt: string;
  /** An ISO-8601 instant, or `null` when no end was recorded (BK5, migration 0213). */
  readonly endsAt: string | null;
  /** The agenda note, or `null` when none was given. `TEXT` on the API. */
  readonly agendaNote: string | null;
  readonly createdByUserId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What the create form sends. Not a paired projection — it is a request body, like `CreateProjectInput`. */
export interface CreateMeetingInput {
  readonly projectId: string;
  readonly title: string;
  /** An ISO-8601 instant, e.g. `2026-10-01T14:00:00.000Z`. */
  readonly startsAt: string;
  readonly agendaNote?: string;
}

/**
 * List a project's meetings. The `projectId` is required — the API refuses the list without it
 * (400), because meetings are per-project and there is no "all projects at once" read to make.
 */
export async function listMeetings(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<{ readonly meetings: readonly MeetingView[] }> {
  const { data } = await client.request<{ readonly meetings: readonly MeetingView[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/meetings?projectId=${encodeURIComponent(projectId)}`,
  });
  return data;
}

/** Create a meeting in a project (behind `meeting.write`). Returns the created meeting (201). */
export async function createMeeting(
  client: ApiClient,
  organizationSlug: string,
  input: CreateMeetingInput,
): Promise<MeetingView> {
  const { data } = await client.request<MeetingView>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/meetings`,
    body: input,
  });
  return data;
}

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
