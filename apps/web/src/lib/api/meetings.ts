import type { ApiClient } from './client';
import type { ProjectSummary } from './projects';

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
 * What the meeting edit form sends (`PATCH .../meetings/:meetingId`, behind `meeting.write`).
 * Absent fields are left alone; `endsAt` and `agendaNote` accept `null` to clear. The API refuses
 * an end that is not after the start (400). A request body, not a paired projection.
 */
export interface UpdateMeetingInput {
  readonly title?: string;
  /** An ISO-8601 instant. */
  readonly startsAt?: string;
  /** An ISO-8601 instant after `startsAt`, or `null` to clear the end. */
  readonly endsAt?: string | null;
  readonly agendaNote?: string | null;
}

/** Edit a meeting after creation (title, start, end, agenda note). Returns the updated meeting. */
export async function updateMeeting(
  client: ApiClient,
  organizationSlug: string,
  meetingId: string,
  input: UpdateMeetingInput,
): Promise<MeetingView> {
  const { data } = await client.request<MeetingView>({
    method: 'PATCH',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/meetings/${encodeURIComponent(meetingId)}`,
    body: input,
  });
  return data;
}

/** The API's page ceiling for the meetings and projects lists (both cap `limit` at 200). */
const PAGE_SIZE = 200;
/** A guard on the page walks: 200 pages of 200 is far past any real tenant. */
const MAX_PAGES = 200;
/** How many projects are read at once when every project's meetings are needed. */
const PROJECT_FAN_OUT = 6;

/**
 * Every project the caller can read, walking the projects list page by page.
 *
 * `listProjects` reads one page at the API's default size (50, oldest first), so a tenant's newer
 * projects — and the meetings in them — were invisible to the calendar. The API filters a page by
 * relation after reading it, so a short page does not mean the end: the walk stops on an empty one.
 */
export async function listAllProjects(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly ProjectSummary[]> {
  const all: ProjectSummary[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (after) query.set('after', after);
    const { data } = await client.request<{ projects: readonly ProjectSummary[] }>({
      path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects?${query.toString()}`,
    });
    const last = data.projects[data.projects.length - 1];
    // An empty page is the end; a page that does not move the cursor would repeat itself.
    if (!last || last.id === after) break;
    all.push(...data.projects);
    after = last.id;
  }
  return all;
}

/** Every meeting of one project, walking its pages with `after`. */
async function listProjectMeetings(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<readonly MeetingView[]> {
  const all: MeetingView[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ projectId, limit: String(PAGE_SIZE) });
    if (after) query.set('after', after);
    const { data } = await client.request<{ readonly meetings: readonly MeetingView[] }>({
      path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/meetings?${query.toString()}`,
    });
    all.push(...data.meetings);
    const last = data.meetings[data.meetings.length - 1];
    if (data.meetings.length < PAGE_SIZE || !last) break;
    after = last.id;
  }
  return all;
}

/**
 * Every meeting in the given projects (all the caller can read when none are given) — the
 * calendar's default "All meetings" view. The API lists per project only, so the projects are read
 * a few at a time and their meetings merged, newest first (ids are UUIDv7, creation order).
 */
export async function listAllMeetings(
  client: ApiClient,
  organizationSlug: string,
  projectIds?: readonly string[],
): Promise<readonly MeetingView[]> {
  const ids = projectIds ?? (await listAllProjects(client, organizationSlug)).map((p) => p.id);
  const all: MeetingView[] = [];
  for (let start = 0; start < ids.length; start += PROJECT_FAN_OUT) {
    const batch = ids.slice(start, start + PROJECT_FAN_OUT);
    const lists = await Promise.all(
      batch.map((projectId) => listProjectMeetings(client, organizationSlug, projectId)),
    );
    for (const list of lists) all.push(...list);
  }
  return all.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/**
 * Find one meeting by id, through the per-project lists.
 *
 * There is no `GET .../meetings/:meetingId` on the API yet, so the meeting is found in its
 * project's list: the given projects when the caller knows them, otherwise every project the caller
 * can read (all pages, not only the first 50). Resolves `null` when no readable project holds it —
 * the screen's not-found state.
 */
export async function getMeeting(
  client: ApiClient,
  organizationSlug: string,
  meetingId: string,
  projectIds?: readonly string[],
): Promise<MeetingView | null> {
  const ids = projectIds ?? (await listAllProjects(client, organizationSlug)).map((p) => p.id);
  for (let start = 0; start < ids.length; start += PROJECT_FAN_OUT) {
    const batch = ids.slice(start, start + PROJECT_FAN_OUT);
    const lists = await Promise.all(
      batch.map((projectId) => listProjectMeetings(client, organizationSlug, projectId)),
    );
    for (const list of lists) {
      const found = list.find((meeting) => meeting.id === meetingId);
      if (found) return found;
    }
  }
  return null;
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
