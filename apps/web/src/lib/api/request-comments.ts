import type { ApiClient } from './client';

/**
 * The request-comments endpoints — x299 (Requests module 11).
 *
 * A client request's internal comment thread: the studio's working notes alongside a request, never
 * shown to the client. The API projection is `RequestCommentView`; this is its web mirror, paired
 * `Exact` in `e2e/contracts`. Append-with-retract: the client reads, adds (optionally as a
 * one-level reply via `parentId`) and removes — there is no edit route, so no update shape.
 */
export interface RequestComment {
  readonly id: string;
  readonly requestId: string;
  readonly parentId: string | null;
  readonly authorMembershipId: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface AddRequestCommentInput {
  readonly body: string;
  readonly parentId?: string;
}

export async function listRequestComments(
  client: ApiClient,
  organizationSlug: string,
  clientRequestId: string,
): Promise<readonly RequestComment[]> {
  const { data } = await client.request<{ comments: readonly RequestComment[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/client-requests/${encodeURIComponent(clientRequestId)}/comments`,
  });
  return data.comments;
}

export async function addRequestComment(
  client: ApiClient,
  organizationSlug: string,
  clientRequestId: string,
  input: AddRequestCommentInput,
): Promise<RequestComment> {
  const { data } = await client.request<RequestComment>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/client-requests/${encodeURIComponent(clientRequestId)}/comments`,
    body: input,
  });
  return data;
}

export async function removeRequestComment(
  client: ApiClient,
  organizationSlug: string,
  clientRequestId: string,
  commentId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/client-requests/${encodeURIComponent(clientRequestId)}/comments/${encodeURIComponent(commentId)}`,
  });
}
