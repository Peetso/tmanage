import type { ApiClient } from './client';

/**
 * A11Y accessibility preferences (module 20, x183) — the caller's own font-scale / reduced-motion
 * / high-contrast settings, read and replaced. Behind `work.read` on the server (the internal-read
 * capability NOTIF-001's preferences reuse); a caller without it gets the ordinary 403 the shared
 * client turns into an error. The tenant is the slug in the path resolved against the caller's
 * membership, and the *member* is the authenticated principal — never a value this client supplies —
 * so it can only ever read or write the caller's own row.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired with the API projection in the
 * `e2e/contracts` shape check so the two shapes cannot drift.
 */

/** The closed font-scale vocabulary the API accepts (`sm|md|lg|xl`); `md` is the default. */
export const A11Y_FONT_SCALES = ['sm', 'md', 'lg', 'xl'] as const;
export type A11yFontScale = (typeof A11Y_FONT_SCALES)[number];

/** The three accessibility settings the GET/PUT route exchanges. Paired Exact with the API view. */
export interface A11yPreferencesView {
  readonly fontScale: A11yFontScale;
  readonly reduceMotion: boolean;
  readonly highContrast: boolean;
}

function path(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/me/accessibility`;
}

export async function getAccessibilityPreferences(
  client: ApiClient,
  organizationSlug: string,
): Promise<A11yPreferencesView> {
  const { data } = await client.request<A11yPreferencesView>({ path: path(organizationSlug) });
  return data;
}

export async function updateAccessibilityPreferences(
  client: ApiClient,
  organizationSlug: string,
  settings: A11yPreferencesView,
): Promise<A11yPreferencesView> {
  const { data } = await client.request<A11yPreferencesView>({
    method: 'PUT',
    path: path(organizationSlug),
    body: settings,
  });
  return data;
}
