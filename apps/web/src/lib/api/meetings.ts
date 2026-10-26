import type { ApiClient } from './client';
import type { ProjectSummary } from './projects';

/**
 * CAL-01 / MTG-01 (x90 API, x122 web) — the meeting list / create.
 *
 * A meeting is a tenant-scoped, project-scoped record served at `.../meetings`: `GET` lists the
 * meetings the caller may read (in a window, or one project's with `projectId`) behind
 * `meeting.read`, `POST` creates one behind `meeting.write`. 0237 adds the meeting page's
 * `/overview` read, cancel, sync and email guests.
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

/** 0237. The video call a meeting carries; the organizer's connected calendar makes the link. */
export type MeetingConference = 'none' | 'google_meet' | 'teams';
/** 0237. An attendee's answer, as Google/Outlook or TManage recorded it. */
export type MeetingAnswer = 'invited' | 'accepted' | 'declined' | 'tentative';

/** 0237. One reminder: a notification or an email, so many minutes before the start. */
interface MeetingReminderShape {
  readonly method: 'popup' | 'email';
  readonly minutes: number;
}

/**
 * 0237. The event options the create/edit form sends — every option a Google Calendar event
 * offers that TManage edits. A request body, not a paired projection.
 */
export interface MeetingOptionsInput {
  readonly allDay?: boolean;
  readonly timeZone?: string | null;
  readonly location?: string | null;
  /** One RFC-5545 RRULE, e.g. `RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261221T000000Z`. */
  readonly rrule?: string | null;
  readonly visibility?: 'default' | 'public' | 'private';
  readonly showAs?: 'busy' | 'free';
  /** Google's event colour `1`..`11`. */
  readonly colorId?: string | null;
  readonly conference?: MeetingConference;
  readonly reminders?: readonly MeetingReminderShape[] | null;
  readonly guestsCanModify?: boolean;
  readonly guestsCanInviteOthers?: boolean;
  readonly guestsCanSeeOthers?: boolean;
}

/** A Drive or OneDrive file picked for the meeting (the API host-checks `webUrl`). */
interface MeetingAttachmentShape {
  readonly provider: 'google_drive' | 'onedrive';
  readonly fileId: string;
  readonly driveId?: string | null;
  readonly title: string;
  readonly mimeType: string;
  readonly webUrl: string;
}

/** What the create form sends. Not a paired projection — it is a request body. */
export interface CreateMeetingInput extends MeetingOptionsInput {
  readonly projectId: string;
  readonly title: string;
  /** An ISO-8601 instant, e.g. `2026-10-01T14:00:00.000Z`. */
  readonly startsAt: string;
  readonly endsAt?: string;
  readonly agendaNote?: string;
  /** Members; the organizer is always added by the API. */
  readonly attendees?: readonly { readonly userId: string; readonly optional: boolean }[];
  /** People outside the team, by email. */
  readonly guests?: readonly {
    readonly email: string;
    readonly displayName?: string | null;
    readonly optional: boolean;
  }[];
  readonly attachments?: readonly MeetingAttachmentShape[];
}

/**
 * The meetings the caller may read in a time window, across every readable project — the
 * calendar's default "All meetings" (`GET …/meetings` without `projectId`; owner bug 1).
 */
export async function listMeetingsInWindow(
  client: ApiClient,
  organizationSlug: string,
  window: { readonly from: string; readonly to: string; readonly includeCancelled?: boolean },
): Promise<readonly MeetingView[]> {
  const query = new URLSearchParams({ from: window.from, to: window.to });
  if (window.includeCancelled) query.set('includeCancelled', 'true');
  const { data } = await client.request<{ readonly meetings: readonly MeetingView[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/meetings?${query.toString()}`,
  });
  return data.meetings;
}

/**
 * List one project's meetings (`?projectId=`), one page. The calendar reads
 * {@link listMeetingsInWindow}; this stays for project-scoped readers.
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
 * Absent fields are left alone; `endsAt`, `agendaNote` and the nullable options accept `null`
 * to clear. A request body, not a paired projection.
 */
export interface UpdateMeetingInput extends MeetingOptionsInput {
  readonly title?: string;
  /** An ISO-8601 instant. */
  readonly startsAt?: string;
  /** An ISO-8601 instant after `startsAt`, or `null` to clear the end. */
  readonly endsAt?: string | null;
  readonly agendaNote?: string | null;
}

/** Edit a meeting after creation. Returns the updated meeting; the calendar push follows. */
export async function updateMeeting(
  client: ApiClient,
  organizationSlug: string,
  meetingId: string,
  input: UpdateMeetingInput,
): Promise<MeetingView> {
  const { data } = await client.request<MeetingView>({
    method: 'PATCH',
    path: meetingPath(organizationSlug, meetingId),
    body: input,
  });
  return data;
}

/** The API's page ceiling for the projects list (`limit` caps at 200). */
const PAGE_SIZE = 200;
/** A guard on the page walk: 200 pages of 200 is far past any real tenant. */
const MAX_PAGES = 200;

/**
 * Every project the caller can read, walking the projects list page by page (the project filter
 * and the form's project picker). The API filters a page by relation after reading it, so a short
 * page does not mean the end: the walk stops on an empty one.
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

/**
 * 0237. Everything the meeting page shows, in one read (`GET …/meetings/:meetingId/overview`):
 * the meeting, its options, everyone invited with their answer, the Meet/Teams link and the sync
 * state, and the attachments. Paired `Exact` with the API's `MeetingOverviewView`. It replaces the
 * old project-by-project scan for one meeting (owner bug 2).
 */
export interface MeetingOverviewView {
  readonly meeting: MeetingView;
  readonly allDay: boolean;
  readonly timeZone: string | null;
  readonly location: string | null;
  readonly rrule: string | null;
  readonly visibility: string;
  readonly showAs: string;
  readonly colorId: string | null;
  readonly conference: string;
  /** `null` = the calendar's default reminders. */
  readonly reminders: readonly MeetingReminderShape[] | null;
  readonly guestsCanModify: boolean;
  readonly guestsCanInviteOthers: boolean;
  readonly guestsCanSeeOthers: boolean;
  readonly cancelledAt: string | null;
  readonly people: readonly {
    readonly kind: 'member' | 'client' | 'guest';
    /** The attendee or guest row id (a guest's is what `removeMeetingGuest` takes). */
    readonly id: string;
    readonly userId: string | null;
    readonly displayName: string | null;
    /** Shown for guests only. */
    readonly email: string | null;
    readonly optional: boolean;
    readonly organizer: boolean;
    readonly rsvp: MeetingAnswer;
  }[];
  /** `null` while the organizer has no calendar connected (the meeting is TManage-only). */
  readonly external: {
    readonly provider: string;
    /** The Meet/Teams link — opened in a new tab; live calls cannot be embedded. */
    readonly joinUrl: string | null;
    readonly htmlLink: string | null;
    readonly syncStatus: string;
    readonly lastErrorCode: string | null;
    readonly lastPushedAt: string | null;
    readonly lastPulledAt: string | null;
  } | null;
  readonly attachments: readonly {
    readonly id: string;
    readonly provider: string;
    readonly title: string;
    readonly mimeType: string;
    readonly webUrl: string | null;
  }[];
}

function meetingPath(organizationSlug: string, meetingId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/meetings/${encodeURIComponent(meetingId)}`;
}

/** The meeting page's read. An unknown or unreadable id is a 404 (the not-found state). */
export async function getMeetingOverview(
  client: ApiClient,
  organizationSlug: string,
  meetingId: string,
): Promise<MeetingOverviewView> {
  const { data } = await client.request<MeetingOverviewView>({
    path: `${meetingPath(organizationSlug, meetingId)}/overview`,
  });
  return data;
}

/** Cancel the meeting; Google/Outlook tell the guests. Returns the meeting. */
export async function cancelMeeting(
  client: ApiClient,
  organizationSlug: string,
  meetingId: string,
): Promise<MeetingView> {
  const { data } = await client.request<MeetingView>({
    method: 'POST',
    path: `${meetingPath(organizationSlug, meetingId)}/cancel`,
  });
  return data;
}

/** "Try again": push to the organizer's calendar again and pull the answers back. */
export async function syncMeeting(
  client: ApiClient,
  organizationSlug: string,
  meetingId: string,
): Promise<MeetingOverviewView> {
  const { data } = await client.request<MeetingOverviewView>({
    method: 'POST',
    path: `${meetingPath(organizationSlug, meetingId)}/sync`,
  });
  return data;
}

/** 0237. A guest invited by email, as the guest routes answer it (mirrors the API entry). */
interface MeetingGuestEntry {
  readonly id: string;
  readonly meetingId: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly optional: boolean;
  readonly rsvp: string;
  readonly createdAt: string;
}

/** Invite someone outside the team by email (behind `meeting.write`). */
export async function addMeetingGuest(
  client: ApiClient,
  organizationSlug: string,
  meetingId: string,
  guest: {
    readonly email: string;
    readonly displayName?: string | null;
    readonly optional: boolean;
  },
): Promise<MeetingGuestEntry> {
  const { data } = await client.request<MeetingGuestEntry>({
    method: 'POST',
    path: `${meetingPath(organizationSlug, meetingId)}/guests`,
    body: guest,
  });
  return data;
}

/** Remove an email guest. */
export async function removeMeetingGuest(
  client: ApiClient,
  organizationSlug: string,
  meetingId: string,
  guestId: string,
): Promise<void> {
  await client.request<unknown>({
    method: 'DELETE',
    path: `${meetingPath(organizationSlug, meetingId)}/guests/${encodeURIComponent(guestId)}`,
  });
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
