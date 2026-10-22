import type { ApiClient } from './client';

/**
 * Q4 — an organization admin sends a member the ordinary reset link:
 * `POST /v1/organizations/:orgSlug/members/:membershipId/password-reset {reason}`, behind
 * `org.manage` on the server. The API answers 202 `{status:'sent'}` and returns no link — the
 * member gets the single-use 30-minute self-service email at their own sign-in address.
 * A caller without the capability gets 403; an unknown or foreign membership 404; resetting
 * yourself, an inactive member or a reason under five characters 422.
 */
export async function sendMemberPasswordReset(
  client: ApiClient,
  organizationSlug: string,
  membershipId: string,
  reason: string,
): Promise<void> {
  await client.request<{ status: 'sent' }>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/members/${encodeURIComponent(
      membershipId,
    )}/password-reset`,
    body: { reason },
  });
}
