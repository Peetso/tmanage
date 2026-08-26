import type { ApiClient } from './client';

/**
 * The invitation endpoints — TEN-003, behind `ON-04` and `ID-03`.
 *
 * Two of the three routes here carry **no organization slug**, which is unusual enough in this
 * folder to state: previewing and accepting happen before the person has a membership, so
 * there is no tenant for a path segment to name. The organization comes from the invitation
 * row on the server.
 *
 * The token travels in a **body** on both, never in a URL. It is a credential that grants
 * membership in an organization, and a URL is in the browser's history, in the `Referer` of the
 * next navigation, and in every access log in between. `apps/web`'s ID-03 route reads the token
 * from its path — that is where an emailed link puts it — and hands it straight to a body
 * without echoing it into the document.
 */

export interface InvitationSummary {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly clientOrganizationId: string | null;
  readonly status: 'pending' | 'accepted' | 'expired' | 'revoked';
  readonly expiresAt: string;
  readonly invitedByUserId: string;
  readonly acceptedByUserId: string | null;
  readonly acceptedAt: string | null;
  readonly createdAt: string;
}

export interface IssuedInvitation {
  readonly invitation: InvitationSummary;
  /**
   * The token, shown once.
   *
   * There is no endpoint that can produce it again — the row holds only a hash — so a screen
   * that discards it has discarded the invitation. `ON-04` renders the link immediately for
   * that reason.
   */
  readonly token: string;
}

export interface IssueInvitationInput {
  readonly email: string;
  readonly role: string;
  /** Null or omitted for an internal invitation; a client organization id for portal access. */
  readonly clientOrganizationId?: string | null;
}

export async function issueInvitation(
  client: ApiClient,
  organizationSlug: string,
  input: IssueInvitationInput,
): Promise<IssuedInvitation> {
  const { data } = await client.request<IssuedInvitation>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/invitations`,
    body: input,
  });
  return data;
}

export async function listInvitations(
  client: ApiClient,
  organizationSlug: string,
  status?: readonly InvitationSummary['status'][],
): Promise<readonly InvitationSummary[]> {
  const suffix =
    status && status.length > 0 ? `?status=${encodeURIComponent(status.join(','))}` : '';
  const { data } = await client.request<{ invitations: readonly InvitationSummary[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/invitations${suffix}`,
  });
  return data.invitations;
}

export async function revokeInvitation(
  client: ApiClient,
  organizationSlug: string,
  invitationId: string,
): Promise<InvitationSummary> {
  const { data } = await client.request<InvitationSummary>({
    method: 'DELETE',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/invitations/${encodeURIComponent(invitationId)}`,
  });
  return data;
}

export interface InvitationPreview {
  readonly organizationName: string;
  readonly inviterName: string;
  readonly inviterEmail: string;
  readonly role: string;
  readonly audience: 'internal' | 'client';
  readonly clientOrganizationName: string | null;
  readonly invitedAt: string;
  readonly expiresAt: string;
}

/** No slug: the invitation says which organization this is. */
export async function previewInvitation(
  client: ApiClient,
  token: string,
): Promise<InvitationPreview> {
  const { data } = await client.request<InvitationPreview>({
    method: 'POST',
    path: '/v1/invitations/previews',
    body: { token },
  });
  return data;
}

export interface AcceptedInvitation {
  readonly organizationId: string;
  readonly membershipId: string;
  readonly clientOrganizationId: string | null;
  readonly role: string;
}

export async function acceptInvitation(
  client: ApiClient,
  token: string,
): Promise<AcceptedInvitation> {
  const { data } = await client.request<AcceptedInvitation>({
    method: 'POST',
    path: '/v1/invitations/acceptances',
    body: { token },
  });
  return data;
}
