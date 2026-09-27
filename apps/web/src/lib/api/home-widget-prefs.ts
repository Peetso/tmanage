import type { ApiClient } from './client';

/**
 * Home widget preferences (module 4 Home / My Day, x243) — the caller's own Home widget order and
 * hidden set, read and replaced. Behind `work.read` on the server (the internal-read capability
 * NOTIF-001's preferences reuse); a caller without it gets the ordinary 403 the shared
 * client turns into an error. The tenant is the slug in the path resolved against the caller's
 * membership, and the *member* is the authenticated principal — never a value this client supplies —
 * so it can only ever read or write the caller's own layout.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired with the API projection in the
 * `e2e/contracts` shape check so the two shapes cannot drift.
 */

/** The closed set of Home-widget ids the API accepts; every saved id is validated against it. */
export const HOME_WIDGET_IDS = [
  'myDay',
  'waiting',
  'pulse',
  'summary',
  'pins',
  'savedContext',
] as const;
export type HomeWidgetId = (typeof HOME_WIDGET_IDS)[number];

/** The member's Home widget layout the GET/PUT route exchanges. Paired Exact with the API view. */
export interface HomeWidgetPrefsView {
  readonly order: readonly HomeWidgetId[];
  readonly hidden: readonly HomeWidgetId[];
}

function path(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/home/widget-prefs`;
}

export async function getHomeWidgetPrefs(
  client: ApiClient,
  organizationSlug: string,
): Promise<HomeWidgetPrefsView> {
  const { data } = await client.request<HomeWidgetPrefsView>({ path: path(organizationSlug) });
  return data;
}

export async function updateHomeWidgetPrefs(
  client: ApiClient,
  organizationSlug: string,
  layout: HomeWidgetPrefsView,
): Promise<HomeWidgetPrefsView> {
  const { data } = await client.request<HomeWidgetPrefsView>({
    method: 'PUT',
    path: path(organizationSlug),
    body: layout,
  });
  return data;
}
