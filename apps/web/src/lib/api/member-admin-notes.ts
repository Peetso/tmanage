import type { ApiClient } from './client';

/**
 * Admin private member notes (Administration module 18, x280) — the member-notes endpoints, all
 * behind `org.manage`.
 *
 * Three calls: list a member's notes (`GET .../admin/members/:membershipId/notes`), add one
 * (`POST` same path) and delete one (`DELETE .../notes/:noteId`). A membership the caller may not
 * manage — and an unknown or cross-tenant id — is a 404, because the API resolves the id
 * tenant-scoped before the `org.manage` authorize, so the panel never has to tell the cases apart.
 * A note is private and internal: it is never surfaced on any member-facing read path.
 */

/**
 * A member note as the API projects it — structurally identical to the API's `MemberAdminNoteView`
 * (`apps/api/src/modules/admin/member-notes.service.ts`), the paired contract view.
 * `organizationId` is deliberately absent: the API never echoes the tenant id into a response body,
 * and neither does this declaration.
 */
export interface MemberAdminNoteView {
  readonly id: string;
  readonly subjectMembershipId: string;
  readonly body: string;
  readonly authorMembershipId: string;
  /** ISO-8601 instant. */
  readonly createdAt: string;
}

function base(organizationSlug: string, membershipId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/admin/members/${encodeURIComponent(membershipId)}/notes`;
}

/** List a member's private notes, newest first. */
export async function listMemberAdminNotes(
  client: ApiClient,
  organizationSlug: string,
  membershipId: string,
): Promise<readonly MemberAdminNoteView[]> {
  const { data } = await client.request<{ notes: readonly MemberAdminNoteView[] }>({
    path: base(organizationSlug, membershipId),
  });
  return data.notes;
}

/** Add a private note to a member. */
export async function addMemberAdminNote(
  client: ApiClient,
  organizationSlug: string,
  membershipId: string,
  body: string,
): Promise<MemberAdminNoteView> {
  const { data } = await client.request<MemberAdminNoteView>({
    method: 'POST',
    path: base(organizationSlug, membershipId),
    body: { body },
  });
  return data;
}

/** Delete a private note from a member. */
export async function deleteMemberAdminNote(
  client: ApiClient,
  organizationSlug: string,
  membershipId: string,
  noteId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${base(organizationSlug, membershipId)}/${encodeURIComponent(noteId)}`,
  });
}
