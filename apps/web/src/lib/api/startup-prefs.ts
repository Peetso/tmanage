import type { ApiClient } from './client';

/**
 * PREF-STARTUP default startup landing view (module 20, x287) — the caller's own choice of which
 * screen the app opens to on sign-in, read and replaced. Behind `work.read` on the server (the
 * internal-read capability the sibling preferences slices reuse); a caller without it gets the
 * ordinary 403 the shared client turns into an error. The tenant is the slug in the path resolved
 * against the caller's membership, and the *member* is the authenticated principal — never a value
 * this client supplies — so it can only ever read or write the caller's own row.
 *
 * Hand-written for the boundary reason `errors.ts` gives; the view shape is paired Exact with the
 * API's `StartupPrefView` so the two cannot drift.
 */

/** The closed vocabulary of screens the app may open to on sign-in. Paired Exact with the API. */
export const LANDING_KEYS = ['home', 'inbox', 'my-work', 'calendar'] as const;
export type LandingKey = (typeof LANDING_KEYS)[number];

/** What the GET/PUT route exchanges: the chosen landing destination. Paired Exact with the API view. */
export interface StartupPrefView {
  readonly landingKey: LandingKey;
}

function path(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/me/startup`;
}

export async function getStartupPref(
  client: ApiClient,
  organizationSlug: string,
): Promise<StartupPrefView> {
  const { data } = await client.request<StartupPrefView>({ path: path(organizationSlug) });
  return data;
}

export async function updateStartupPref(
  client: ApiClient,
  organizationSlug: string,
  landingKey: LandingKey,
): Promise<StartupPrefView> {
  const { data } = await client.request<StartupPrefView>({
    method: 'PUT',
    path: path(organizationSlug),
    body: { landingKey },
  });
  return data;
}
