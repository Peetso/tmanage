import type { PublicLinkManagedStatus, PublicLinkStateFilter } from '@tmanage/domain';
import type { ApiClient } from './client';

/**
 * 56-07p · Settings · Public links — the workspace's links that open without signing in.
 *
 * `GET …/public-links/manage` lists them (owner and admin, `org.security.manage` on the server),
 * `POST …/manage/revoke` revokes many and `POST …/manage/expiry` moves their end. One link is
 * revoked by the existing `DELETE …/public-links/:linkId`. The list carries metadata only — no
 * token and no token hint ever reaches this screen.
 */

/** One link. Paired Exact with the API's `ManagedPublicLinkView`. */
export interface ManagedPublicLinkView {
  readonly id: string;
  readonly kind: 'approval' | 'intake' | 'quote' | 'share' | 'magic_signin';
  /** Where "Open what it shows" goes: the deliverable (with its project) or the quote. */
  readonly opens:
    | { readonly projectId: string; readonly deliverableId: string }
    | { readonly quoteId: string }
    | null;
  readonly title: string | null;
  readonly reference: string | null;
  readonly audienceEmail: string | null;
  readonly createdByUserId: string | null;
  readonly createdByName: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastOpenedAt: string | null;
  readonly openCount: number;
  readonly status: PublicLinkManagedStatus;
  readonly revokedAt: string | null;
  readonly revokedByName: string | null;
}

/** The page. Paired Exact with the API's `PublicLinkManagerView`. */
export interface PublicLinkManagerView {
  readonly links: readonly ManagedPublicLinkView[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly counts: {
    readonly active: number;
    readonly endingSoon: number;
    readonly ended: number;
  };
  readonly kinds: readonly ManagedPublicLinkView['kind'][];
  readonly creators: readonly { readonly id: string; readonly name: string }[];
}

/** A bulk change. Paired Exact with the API's `PublicLinkBulkResultView`. */
export interface PublicLinkBulkResultView {
  readonly changed: number;
  readonly skipped: number;
}

export interface PublicLinkManagerQuery {
  readonly search: string;
  readonly kind: string;
  readonly createdBy: string;
  readonly state: PublicLinkStateFilter;
  readonly page: number;
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/public-links`;
}

export function publicLinkManagerKey(organizationSlug: string, query?: PublicLinkManagerQuery) {
  return query === undefined
    ? (['public-link-manager', organizationSlug] as const)
    : (['public-link-manager', organizationSlug, query] as const);
}

export async function fetchPublicLinkManager(
  client: ApiClient,
  organizationSlug: string,
  query: PublicLinkManagerQuery,
): Promise<PublicLinkManagerView> {
  const params = new URLSearchParams({ state: query.state, page: String(query.page) });
  if (query.search.trim() !== '') params.set('q', query.search.trim());
  if (query.kind !== '') params.set('kind', query.kind);
  if (query.createdBy !== '') params.set('createdBy', query.createdBy);
  const { data } = await client.request<PublicLinkManagerView>({
    path: `${base(organizationSlug)}/manage?${params.toString()}`,
  });
  return data;
}

/** Revoke one link through the existing single revoke route. */
export async function revokePublicLink(
  client: ApiClient,
  organizationSlug: string,
  linkId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${base(organizationSlug)}/${encodeURIComponent(linkId)}`,
  });
}

export async function revokePublicLinks(
  client: ApiClient,
  organizationSlug: string,
  linkIds: readonly string[],
): Promise<PublicLinkBulkResultView> {
  const { data } = await client.request<PublicLinkBulkResultView>({
    method: 'POST',
    path: `${base(organizationSlug)}/manage/revoke`,
    body: { linkIds },
  });
  return data;
}

/** `expiresAt`: the end of the chosen day in the reader's own time zone, as an instant. */
export async function changePublicLinkExpiry(
  client: ApiClient,
  organizationSlug: string,
  linkIds: readonly string[],
  expiresAt: string,
): Promise<PublicLinkBulkResultView> {
  const { data } = await client.request<PublicLinkBulkResultView>({
    method: 'POST',
    path: `${base(organizationSlug)}/manage/expiry`,
    body: { linkIds, expiresAt },
  });
  return data;
}
