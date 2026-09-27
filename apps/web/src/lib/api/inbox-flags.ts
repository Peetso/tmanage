import type { ApiClient } from './client';

/**
 * Inbox flags (INBOX-001 IN-01 "Important inbox", x260) — the caller's own "important" star on an inbox
 * bundle, flagged and unflagged, and the list of flagged bundle ids. Behind `work.read` on the server
 * (the capability the inbox itself requires); a caller without it gets the ordinary 403 the shared
 * client turns into an error. The tenant is the slug in the path resolved against the caller's
 * membership, and the *member* is the authenticated principal — never a value this client supplies — so
 * it can only ever flag, unflag or list the caller's own bundles. The server re-checks that the bundle
 * is the caller's before it writes, so flagging a bundle that is not theirs is a 404.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired shape-for-shape with the API views.
 */

/** A single bundle's flag state, returned by PUT. Paired Exact with the API `InboxFlagView`. */
export interface InboxFlagView {
  readonly bundleId: string;
  readonly flagged: boolean;
}

/** The caller's flagged bundle ids, newest first. Paired Exact with the API `InboxFlaggedView`. */
export interface InboxFlaggedView {
  readonly bundleIds: readonly string[];
}

function flagPath(organizationSlug: string, bundleId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/inbox/${encodeURIComponent(bundleId)}/flag`;
}

export async function listFlaggedBundles(
  client: ApiClient,
  organizationSlug: string,
): Promise<InboxFlaggedView> {
  const { data } = await client.request<InboxFlaggedView>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/inbox/flagged`,
  });
  return data;
}

export async function flagBundle(
  client: ApiClient,
  organizationSlug: string,
  bundleId: string,
): Promise<InboxFlagView> {
  const { data } = await client.request<InboxFlagView>({
    method: 'PUT',
    path: flagPath(organizationSlug, bundleId),
  });
  return data;
}

export async function unflagBundle(
  client: ApiClient,
  organizationSlug: string,
  bundleId: string,
): Promise<void> {
  await client.request<void>({ method: 'DELETE', path: flagPath(organizationSlug, bundleId) });
}
