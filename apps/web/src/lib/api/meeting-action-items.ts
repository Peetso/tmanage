import type { ApiClient } from './client';

/**
 * CAL / MTG-03 meeting action items (x266) — the actions captured on a meeting.
 *
 * A meeting's action items are a tenant-scoped, meeting-scoped record served under a meeting:
 * `GET .../meetings/:meetingId/action-items` lists them behind `meeting.read`; `POST` captures one,
 * `PATCH .../action-items/:actionItemId` edits it (and toggles open/done), and `DELETE` removes it,
 * all behind `meeting.write`. The meeting is named by the path and resolved tenant-scoped on the API
 * before the relation check (the Known-trap order), so an unknown or cross-tenant meeting id is a
 * 404 — the screen shows a not-found state rather than an empty list that would confirm the meeting
 * exists.
 */

/** Outstanding or completed. */
export type ActionItemStatus = 'open' | 'done';

/**
 * One action item, as the screen reads it. Paired `Exact` with the API's `MeetingActionItemView` in
 * the contracts gate (`e2e/contracts/api-web-shapes.ts`). The owner is named by `ownerMembershipId`
 * (the roster's tenant-composite identity), or null when unassigned; `organizationId` is deliberately
 * absent — it is never echoed into a response body (`25-AUTH-AND-TENANT-ISOLATION` §7).
 */
export interface MeetingActionItemView {
  readonly id: string;
  readonly meetingId: string;
  readonly title: string;
  readonly ownerMembershipId: string | null;
  /** A `YYYY-MM-DD` date-only string on the wire, or null for no due date. */
  readonly dueOn: string | null;
  readonly status: ActionItemStatus;
  /** An ISO-8601 instant on the wire. */
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What the capture form sends. A request body, not a paired projection. */
export interface CreateActionItemInput {
  readonly title: string;
  readonly ownerMembershipId?: string | null;
  readonly dueOn?: string | null;
}

/** What an edit sends — any subset of the mutable fields. */
export interface UpdateActionItemInput {
  readonly title?: string;
  readonly ownerMembershipId?: string | null;
  readonly dueOn?: string | null;
  readonly status?: ActionItemStatus;
}

/** List a meeting's action items (behind `meeting.read`). */
export async function listMeetingActionItems(
  client: ApiClient,
  organizationSlug: string,
  meetingId: string,
): Promise<{ readonly actionItems: readonly MeetingActionItemView[] }> {
  const { data } = await client.request<{ readonly actionItems: readonly MeetingActionItemView[] }>(
    {
      path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/meetings/${encodeURIComponent(meetingId)}/action-items`,
    },
  );
  return data;
}

/** Capture an action item on a meeting (behind `meeting.write`). Returns the created item (201). */
export async function createMeetingActionItem(
  client: ApiClient,
  organizationSlug: string,
  meetingId: string,
  input: CreateActionItemInput,
): Promise<MeetingActionItemView> {
  const { data } = await client.request<MeetingActionItemView>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/meetings/${encodeURIComponent(meetingId)}/action-items`,
    body: input,
  });
  return data;
}

/** Edit an action item, or toggle its status (behind `meeting.write`). Returns the updated item. */
export async function updateMeetingActionItem(
  client: ApiClient,
  organizationSlug: string,
  meetingId: string,
  actionItemId: string,
  input: UpdateActionItemInput,
): Promise<MeetingActionItemView> {
  const { data } = await client.request<MeetingActionItemView>({
    method: 'PATCH',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/meetings/${encodeURIComponent(meetingId)}/action-items/${encodeURIComponent(actionItemId)}`,
    body: input,
  });
  return data;
}

/** Remove an action item (behind `meeting.write`). */
export async function deleteMeetingActionItem(
  client: ApiClient,
  organizationSlug: string,
  meetingId: string,
  actionItemId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/meetings/${encodeURIComponent(meetingId)}/action-items/${encodeURIComponent(actionItemId)}`,
  });
}
