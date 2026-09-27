import type { ApiClient } from './client';

/**
 * Home quick links (module 4 Home / My Day, x273) — the caller's own small, ordered list of personal
 * shortcuts on My Day, each a label and a relative in-app path, read/added/reordered/removed. Behind
 * `work.read` on the server (the internal-read capability x243's widget prefs and x144's Home pins
 * reuse); a caller without it gets the ordinary 403 the shared client turns into an error. The tenant
 * is the slug in the path resolved against the caller's membership, and the *member* is the
 * authenticated principal — never a value this client supplies — so it can only ever read or change
 * the caller's own links.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired Exact with the API projection so
 * the two shapes cannot drift.
 */

/** One quick link the GET/POST/PUT/DELETE routes exchange. Paired Exact with the API view. */
export interface HomeQuickLink {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly position: number;
}

/** The caller's quick links, in position order. */
export interface HomeQuickLinksView {
  readonly links: readonly HomeQuickLink[];
}

/** The most quick links a member may keep — mirrors the server cap, for the add button's guard. */
export const MAX_QUICK_LINKS = 20;

function basePath(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/home/quick-links`;
}

export async function getHomeQuickLinks(
  client: ApiClient,
  organizationSlug: string,
): Promise<HomeQuickLinksView> {
  const { data } = await client.request<HomeQuickLinksView>({ path: basePath(organizationSlug) });
  return data;
}

export async function addHomeQuickLink(
  client: ApiClient,
  organizationSlug: string,
  input: { readonly label: string; readonly path: string },
): Promise<HomeQuickLinksView> {
  const { data } = await client.request<HomeQuickLinksView>({
    method: 'POST',
    path: basePath(organizationSlug),
    body: input,
  });
  return data;
}

export async function reorderHomeQuickLinks(
  client: ApiClient,
  organizationSlug: string,
  ids: readonly string[],
): Promise<HomeQuickLinksView> {
  const { data } = await client.request<HomeQuickLinksView>({
    method: 'PUT',
    path: `${basePath(organizationSlug)}/order`,
    body: { ids },
  });
  return data;
}

export async function removeHomeQuickLink(
  client: ApiClient,
  organizationSlug: string,
  id: string,
): Promise<HomeQuickLinksView> {
  const { data } = await client.request<HomeQuickLinksView>({
    method: 'DELETE',
    path: `${basePath(organizationSlug)}/${encodeURIComponent(id)}`,
  });
  return data;
}

/**
 * Whether a path is a safe relative in-app destination, mirroring the server's open-redirect guard so
 * the form can refuse an off-site path before it is sent (the server refuses it regardless). Leading
 * "/", not protocol-relative "//", no scheme "://", no backslash, no control characters.
 */
export function isSafeInAppPath(path: string): boolean {
  if (!path.startsWith('/')) return false;
  if (path.startsWith('//')) return false;
  if (path.includes('\\')) return false;
  if (path.includes('://')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(path)) return false;
  return true;
}
