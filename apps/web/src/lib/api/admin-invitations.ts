import type { ApiClient } from './client';
import type { IssuedInvitation } from './invitations';

/**
 * Admin pending-invitation management (Administration module 18, x328).
 *
 * Wraps the admin invitations API: list the tenant's pending invitations and revoke one, both behind
 * `org.manage` on the server. The one exported response shape is {@link AdminInvitationsView}, paired
 * Exact with the API's `AdminInvitationsView` in the contracts gate — metadata only, and the token hash
 * is never on the wire. Revoke returns nothing (204); resending an invitation email is out of scope
 * (it needs the email provider), so there is no resend helper here.
 */

/** The tenant's pending invitations — metadata only. Paired Exact with the API. */
export interface AdminInvitationsView {
  readonly invitations: readonly {
    readonly id: string;
    readonly email: string;
    readonly role: string;
    readonly invitedByUserId: string;
    readonly invitedByName: string;
    readonly invitedByEmail: string;
    readonly expiresAt: string;
    readonly createdAt: string;
    readonly isExpired: boolean;
    /** R38 G4: the projects the invitation is tagged with (shared or joined on acceptance). */
    readonly projects: readonly { readonly id: string; readonly name: string }[];
    /** 56-26 (B1): TManage stopped mailing this address — the invitation did not arrive. */
    readonly deliveryStopped: boolean;
  }[];
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/admin/invitations`;
}

/** List the tenant's pending invitations. */
export async function fetchPendingInvitations(
  client: ApiClient,
  organizationSlug: string,
): Promise<AdminInvitationsView> {
  const { data } = await client.request<AdminInvitationsView>({ path: base(organizationSlug) });
  return data;
}

/** Revoke one pending invitation. Idempotent on the server (already-revoked is a no-op). */
export async function revokeInvitation(
  client: ApiClient,
  organizationSlug: string,
  invitationId: string,
): Promise<void> {
  await client.request<void>({
    method: 'POST',
    path: `${base(organizationSlug)}/${encodeURIComponent(invitationId)}/revoke`,
  });
}

/**
 * Re-issue one pending invitation (`POST invitations/:id/reissues`): the API revokes the old one and
 * issues a new one in a single transaction, with a new link and a fresh expiry, and mails it. With a
 * `role` this is how a pending invitation's role is changed (2026-10-31 live test: there was no way
 * to change it); without one it is "Resend invitation".
 */
export async function reissueInvitation(
  client: ApiClient,
  organizationSlug: string,
  invitationId: string,
  role?: string,
): Promise<IssuedInvitation> {
  const { data } = await client.request<IssuedInvitation>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/invitations/${encodeURIComponent(invitationId)}/reissues`,
    body: role === undefined ? {} : { role },
  });
  return data;
}
