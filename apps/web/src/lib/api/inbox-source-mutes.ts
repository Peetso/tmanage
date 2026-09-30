import type { ApiClient } from './client';
import type { InboxItem } from './inbox';

/**
 * INBOX source mutes (x318) — a member mutes a specific inbox source object (a `work_item`, a
 * `client_request`, or the `organization_usage` notice) so its bundle is filtered out of *their*
 * inbox, un-mutes it, and lists their mutes.
 *
 * Behind `work.read` on the server (the same capability `InboxController` requires); a caller
 * without it gets the ordinary 403 the shared client turns into an error. The tenant is the slug in
 * the path resolved against the caller's membership, and the *member* is the authenticated principal
 * — never a value this client supplies — so it can only ever read or write the caller's own mutes.
 *
 * Paired with the API projection (`InboxSourceMutesService.InboxSourceMutesView`) so the two shapes
 * cannot drift.
 */

/** The inbox object-type prefixes a source mute can name — paired Exact with the API allowlist. */
export type InboxMuteObjectType = 'work_item' | 'client_request' | 'organization_usage';

/** One muted source — paired Exact with the API view. `createdAt` is an ISO string on the wire. */
export interface InboxSourceMute {
  readonly objectType: InboxMuteObjectType;
  readonly objectId: string;
  readonly createdAt: string;
}

/** The caller's mutes the GET route returns. */
export interface InboxSourceMutesView {
  readonly mutes: readonly InboxSourceMute[];
}

function sourceMutesPath(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/inbox/source-mutes`;
}

export async function listSourceMutes(
  client: ApiClient,
  organizationSlug: string,
): Promise<InboxSourceMutesView> {
  const { data } = await client.request<InboxSourceMutesView>({
    path: sourceMutesPath(organizationSlug),
  });
  return data;
}

/** Mute a source (idempotent — re-muting the same source is a no-op). */
export async function muteSource(
  client: ApiClient,
  organizationSlug: string,
  objectType: InboxMuteObjectType,
  objectId: string,
): Promise<InboxSourceMutesView> {
  const { data } = await client.request<InboxSourceMutesView>({
    method: 'PUT',
    path: sourceMutesPath(organizationSlug),
    body: { objectType, objectId },
  });
  return data;
}

/** Un-mute a source. Returns the caller's mutes after the delete (the GET reloads on the caller). */
export async function unmuteSource(
  client: ApiClient,
  organizationSlug: string,
  objectType: InboxMuteObjectType,
  objectId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: sourceMutesPath(organizationSlug),
    body: { objectType, objectId },
  });
}

/** The `objectType\x00objectId` key of a source — the shape the muted-source set is keyed by. */
function sourceKey(objectType: string, objectId: string): string {
  return `${objectType}\u0000${objectId}`;
}

/** The set of muted source keys, for a membership-scoped exclusion of inbox items. */
export function mutedSourceKeys(mutes: readonly InboxSourceMute[]): ReadonlySet<string> {
  return new Set(mutes.map((mute) => sourceKey(mute.objectType, mute.objectId)));
}

/**
 * The active inbox with muted sources removed — an item whose `(objectType, objectId)` the caller
 * has muted does not show. The filtering is the client's, over the same object identity the inbox
 * page and the mute routes share; the server's inbox is unchanged this slice (the additive read-side
 * filter the brief documents for the integrator to apply where the bundle is composed).
 */
export function filterMutedInbox(
  items: readonly InboxItem[],
  mutes: readonly InboxSourceMute[],
): readonly InboxItem[] {
  const muted = mutedSourceKeys(mutes);
  return items.filter((item) => !muted.has(sourceKey(item.objectType, item.objectId)));
}
