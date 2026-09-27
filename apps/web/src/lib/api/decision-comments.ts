import type { ApiClient } from './client';

/**
 * x317. A decision's internal comment thread — the discussion hanging off a decision on the
 * register (Requests, decisions & approvals: decision discussion). Gated on the server by
 * `work.read`: decisions are internal, so every route here is internal-only.
 *
 * Three calls: list a decision's comments oldest-first, add one, and delete one's own. The API's
 * `DecisionCommentView` is mirrored here as {@link DecisionComment}, paired `Exact` in
 * `e2e/contracts`. `organizationId` is never on the wire.
 */
export interface DecisionComment {
  readonly id: string;
  readonly decisionId: string;
  /** The membership that authored the comment. */
  readonly authorMembershipId: string;
  readonly body: string;
  /** An ISO-8601 instant. */
  readonly createdAt: string;
}

export async function listDecisionComments(
  client: ApiClient,
  organizationSlug: string,
  decisionId: string,
): Promise<readonly DecisionComment[]> {
  const { data } = await client.request<{ comments: readonly DecisionComment[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/decisions/${encodeURIComponent(decisionId)}/comments`,
  });
  return data.comments;
}

export async function addDecisionComment(
  client: ApiClient,
  organizationSlug: string,
  decisionId: string,
  input: { readonly body: string },
): Promise<DecisionComment> {
  const { data } = await client.request<DecisionComment>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/decisions/${encodeURIComponent(decisionId)}/comments`,
    body: input,
  });
  return data;
}

export async function deleteDecisionComment(
  client: ApiClient,
  organizationSlug: string,
  decisionId: string,
  commentId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/decisions/${encodeURIComponent(decisionId)}/comments/${encodeURIComponent(commentId)}`,
  });
}
