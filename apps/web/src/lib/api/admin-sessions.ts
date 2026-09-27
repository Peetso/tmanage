import type { ApiClient } from './client';

/**
 * Admin active sessions + revocation (Administration module 18, x223).
 *
 * Wraps the two `org.manage` routes x223 adds over ID-001's session storage: list the live
 * sessions of the organization's members, and revoke one. The one exported response shape is
 * {@link ActiveSessionView}, paired Exact with the API's `ActiveSessionView` in the contracts
 * gate. Authorization and tenant scope are entirely the server's — a caller without `org.manage`
 * gets the API's 403, and a session belonging to no member of this organization is a 404. This
 * client only carries the request and the refusal back to the screen, and the projection it
 * receives is metadata only: it never carries a token or any other credential material.
 */

/** One row of the admin session list. Paired Exact with the API. Metadata only, no token. */
export interface ActiveSessionView {
  readonly sessionId: string;
  readonly membershipId: string;
  readonly memberName: string;
  /** ISO-8601. When the session was established. */
  readonly createdAt: string;
  /** ISO-8601. Last activity — the last rotation, or the creation time if never rotated. */
  readonly lastSeenAt: string;
  /** The device label (user-agent) captured at sign-in, or `null` if none was sent. */
  readonly deviceLabel: string | null;
}

/**
 * The list's response body. An object-literal `type` alias rather than an exported interface,
 * so the contracts gate does not enumerate it as a second response shape: the paired projection
 * is the row {@link ActiveSessionView}.
 */
type AdminSessionsPage = { readonly sessions: readonly ActiveSessionView[] };

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/admin/sessions`;
}

/** List the live sessions of the organization's members (behind `org.manage`). */
export async function listOrgSessions(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly ActiveSessionView[]> {
  const { data } = await client.request<AdminSessionsPage>({ path: base(organizationSlug) });
  return data.sessions;
}

/** Soft-close one session (behind `org.manage`; idempotent — a re-revoke is a no-op). */
export async function revokeOrgSession(
  client: ApiClient,
  organizationSlug: string,
  sessionId: string,
): Promise<void> {
  await client.request({
    method: 'POST',
    path: `${base(organizationSlug)}/${encodeURIComponent(sessionId)}/revoke`,
  });
}
