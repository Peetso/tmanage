import type { ApiClient } from './client';

/**
 * The public resources/guides endpoints — module 1's resource index and article reads (x187).
 *
 * `GET /v1/public/site/resources` and `GET /v1/public/site/resources/:slug` are `@Public()` on the
 * API: no session, no organization, no capability. They take no request body and return the same
 * deterministic content for every visitor. Nested shapes are inlined so `PublicResourceListView` is
 * the single index projection paired Exact with the API's `PublicResourceListView`, and
 * `PublicResourceView` the single article projection, both in `e2e/contracts/api-web-shapes.ts`.
 */

/** The resources/guides index: one card per entry (no article body — that is fetched per slug). */
export interface PublicResourceListView {
  readonly resources: readonly {
    readonly slug: string;
    readonly title: string;
    readonly summary: string;
    readonly category: string;
  }[];
}

/** One resource/guide article: the card fields plus the rendered body. */
export interface PublicResourceView {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly category: string;
  readonly body: string;
}

export async function fetchPublicResources(client: ApiClient): Promise<PublicResourceListView> {
  const { data } = await client.request<PublicResourceListView>({
    path: '/v1/public/site/resources',
    // No session is involved: these are public pages, read before any sign-in.
    authentication: 'none',
  });
  return data;
}

export async function fetchPublicResource(
  client: ApiClient,
  slug: string,
): Promise<PublicResourceView> {
  const { data } = await client.request<PublicResourceView>({
    path: `/v1/public/site/resources/${encodeURIComponent(slug)}`,
    authentication: 'none',
  });
  return data;
}
