import type { ApiClient } from './client';

/**
 * Request tags — free-text triage labels on a client request (x316, Requests module 11).
 *
 * Wraps the request-tags API: list a request's tags, add a free-text label, and remove one. Behind
 * `client_request.triage` on the server (REQ-001's internal-only capability, reused); a caller without
 * it gets the 403 the shared client turns into an error, an empty / over-length label a 400, and a
 * duplicate a 409. The response shape {@link RequestTagsView} is paired Exact with the API's
 * `RequestTagsView` in the contracts gate so the two cannot drift. The tenant is the slug in the path
 * resolved against the caller's membership; a cross-tenant request id is a 404, never a leak.
 */

/** One tag on a client request — the element type of {@link RequestTagsView.tags}. */
interface RequestTagItemRow {
  readonly id: string;
  readonly clientRequestId: string;
  readonly label: string;
  readonly createdByUserId: string;
  readonly createdAt: string;
}

/** The tags on one client request. */
export interface RequestTagsView {
  readonly clientRequestId: string;
  readonly tags: readonly RequestTagItemRow[];
}

/** One tag, named for the screen — the element type of {@link RequestTagsView.tags}. */
export type RequestTagItem = RequestTagsView['tags'][number];

function base(organizationSlug: string, clientRequestId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/client-requests/${encodeURIComponent(
    clientRequestId,
  )}/tags`;
}

/** List the tags on a client request. */
export async function fetchRequestTags(
  client: ApiClient,
  organizationSlug: string,
  clientRequestId: string,
): Promise<RequestTagsView> {
  const { data } = await client.request<RequestTagsView>({
    path: base(organizationSlug, clientRequestId),
  });
  return data;
}

/** Tag a request with a free-text label. Returns the request's full tag set after the write. */
export async function addRequestTag(
  client: ApiClient,
  organizationSlug: string,
  clientRequestId: string,
  label: string,
): Promise<RequestTagsView> {
  const { data } = await client.request<RequestTagsView>({
    method: 'POST',
    path: base(organizationSlug, clientRequestId),
    body: { label },
  });
  return data;
}

/** Untag a request. Resolves once the server has removed the tag (or confirmed it was absent). */
export async function removeRequestTag(
  client: ApiClient,
  organizationSlug: string,
  clientRequestId: string,
  tagId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${base(organizationSlug, clientRequestId)}/${encodeURIComponent(tagId)}`,
  });
}
