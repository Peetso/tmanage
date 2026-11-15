import type { ApiClient } from './client';
import { ApiRequestError } from './errors';
import type { MeetingView } from './meetings';

/**
 * 53-12 — the meeting join flow, attendance and quick rooms (`…/meetings/:meetingId/call|join|
 * attendance|quick-room`, and the portal's `…/portal/meetings/:meetingId/call|join`). Each view is
 * paired `Exact` with the API in `e2e/contracts/api-web-shapes.ts`.
 */

export type MeetingCallKind = 'calendar' | 'link' | 'quick_room';
export type MeetingCallProvider = 'google_meet' | 'teams' | 'zoom' | 'webex' | 'whereby' | 'jitsi';
export type MeetingJoinState = 'not_open' | 'open' | 'ended';
export type MeetingAttendanceStatus = 'present' | 'late' | 'absent' | 'expected';

/** The call card. `url` is null for anyone not invited, and always null on the portal read. */
export interface MeetingCallView {
  readonly kind: MeetingCallKind | null;
  readonly provider: MeetingCallProvider | null;
  readonly host: string | null;
  readonly url: string | null;
  readonly invited: boolean;
  readonly joinState: MeetingJoinState;
  readonly opensAt: string;
  readonly closesAt: string;
}

export interface MeetingJoinView {
  readonly url: string;
  readonly kind: MeetingCallKind;
  readonly provider: MeetingCallProvider;
  readonly joinedAt: string;
}

export interface MeetingAttendancePerson {
  readonly userId: string;
  readonly kind: 'member' | 'client';
  readonly displayName: string | null;
  readonly organizer: boolean;
  readonly status: MeetingAttendanceStatus;
  readonly lateMinutes: number | null;
  readonly joinedAt: string | null;
  readonly lastJoinedAt: string | null;
  readonly source: 'join_click' | 'manual' | null;
}

export interface MeetingAttendanceView {
  readonly meetingId: string;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly joinState: MeetingJoinState;
  readonly people: readonly MeetingAttendancePerson[];
}

/** Why the API refused a Join (409 `conflict`, `details[0]`), or null for any other error. */
export type JoinRefusal = 'not_open' | 'ended' | 'cancelled' | 'no_call_link';

export function joinRefusalOf(error: unknown): JoinRefusal | null {
  if (!(error instanceof ApiRequestError) || error.status !== 409) return null;
  const reason = error.details?.find((d) => d.field === 'join')?.message;
  return reason === 'not_open' ||
    reason === 'ended' ||
    reason === 'cancelled' ||
    reason === 'no_call_link'
    ? reason
    : null;
}

const meetingBase = (orgSlug: string, meetingId: string): string =>
  `/v1/organizations/${encodeURIComponent(orgSlug)}/meetings/${encodeURIComponent(meetingId)}`;
const portalBase = (orgSlug: string, meetingId: string): string =>
  `/v1/organizations/${encodeURIComponent(orgSlug)}/portal/meetings/${encodeURIComponent(meetingId)}`;

export async function getMeetingCall(
  client: ApiClient,
  orgSlug: string,
  meetingId: string,
): Promise<MeetingCallView> {
  const { data } = await client.request<MeetingCallView>({
    path: `${meetingBase(orgSlug, meetingId)}/call`,
  });
  return data;
}

/** "Add call link" (an allow-listed https meeting link), or `null` to remove it ("End room"). */
export async function setMeetingCall(
  client: ApiClient,
  orgSlug: string,
  meetingId: string,
  url: string | null,
): Promise<MeetingCallView> {
  const { data } = await client.request<MeetingCallView>({
    method: 'PUT',
    path: `${meetingBase(orgSlug, meetingId)}/call`,
    body: { url },
  });
  return data;
}

/** Join: the API marks the caller present and answers the call link. */
export async function joinMeeting(
  client: ApiClient,
  orgSlug: string,
  meetingId: string,
): Promise<MeetingJoinView> {
  const { data } = await client.request<MeetingJoinView>({
    method: 'POST',
    path: `${meetingBase(orgSlug, meetingId)}/join`,
  });
  return data;
}

export async function getMeetingAttendance(
  client: ApiClient,
  orgSlug: string,
  meetingId: string,
): Promise<MeetingAttendanceView> {
  const { data } = await client.request<MeetingAttendanceView>({
    path: `${meetingBase(orgSlug, meetingId)}/attendance`,
  });
  return data;
}

export async function markMeetingAttendance(
  client: ApiClient,
  orgSlug: string,
  meetingId: string,
  userId: string,
  status: 'present' | 'absent',
): Promise<MeetingAttendanceView> {
  const { data } = await client.request<MeetingAttendanceView>({
    method: 'PUT',
    path: `${meetingBase(orgSlug, meetingId)}/attendance/${encodeURIComponent(userId)}`,
    body: { status },
  });
  return data;
}

export async function startQuickRoom(
  client: ApiClient,
  orgSlug: string,
  meetingId: string,
): Promise<MeetingCallView> {
  const { data } = await client.request<MeetingCallView>({
    method: 'POST',
    path: `${meetingBase(orgSlug, meetingId)}/quick-room`,
  });
  return data;
}

/** A 30-minute meeting that starts now, with a quick room. */
export async function createQuickRoom(
  client: ApiClient,
  orgSlug: string,
  input: { readonly projectId: string; readonly title?: string },
): Promise<{ readonly meeting: MeetingView; readonly call: MeetingCallView }> {
  const { data } = await client.request<{
    readonly meeting: MeetingView;
    readonly call: MeetingCallView;
  }>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(orgSlug)}/meetings/quick-room`,
    body: input,
  });
  return data;
}

export async function getPortalMeetingCall(
  client: ApiClient,
  orgSlug: string,
  meetingId: string,
): Promise<MeetingCallView> {
  const { data } = await client.request<MeetingCallView>({
    path: `${portalBase(orgSlug, meetingId)}/call`,
  });
  return data;
}

export async function joinPortalMeeting(
  client: ApiClient,
  orgSlug: string,
  meetingId: string,
): Promise<MeetingJoinView> {
  const { data } = await client.request<MeetingJoinView>({
    method: 'POST',
    path: `${portalBase(orgSlug, meetingId)}/join`,
  });
  return data;
}

/** The portal's own meeting, as `GET …/portal/meetings/:meetingId` answers it (BK5). */
export interface PortalMeetingAttendeeView {
  readonly displayName: string;
  readonly kind: 'team' | 'client';
  readonly organizer: boolean;
  readonly rsvp: 'invited' | 'accepted' | 'declined' | 'tentative';
}

export interface PortalMeetingDetailView {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly attendeeId: string;
  readonly rsvp: 'invited' | 'accepted' | 'declined' | 'tentative';
  readonly attendees: readonly PortalMeetingAttendeeView[];
}

export async function getPortalMeeting(
  client: ApiClient,
  orgSlug: string,
  meetingId: string,
): Promise<PortalMeetingDetailView> {
  const { data } = await client.request<PortalMeetingDetailView>({
    path: portalBase(orgSlug, meetingId),
  });
  return data;
}
