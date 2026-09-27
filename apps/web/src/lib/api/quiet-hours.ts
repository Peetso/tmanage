import type { ApiClient } from './client';

/**
 * PREF-QUIET notification quiet hours (module 20, x215) — the caller's own do-not-disturb window,
 * read, replaced, and evaluated. Behind `work.read` on the server (the internal-read capability the
 * sibling preferences slices reuse); a caller without it gets the ordinary 403 the shared client turns
 * into an error. The tenant is the slug in the path resolved against the caller's membership, and the
 * *member* is the authenticated principal — never a value this client supplies — so it can only ever
 * read or write the caller's own row.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired with the API projections in the
 * `e2e/contracts` shape check so the two shapes cannot drift.
 */

/** The whole quiet-hours window the GET/PUT route exchanges. Paired Exact with the API view. */
export interface QuietHoursView {
  readonly enabled: boolean;
  readonly startTime: string;
  readonly endTime: string;
  readonly timezone: string;
  readonly days: readonly number[];
}

/** Whether the caller is currently inside their window. Paired Exact with the API view. */
export interface QuietHoursActiveView {
  readonly active: boolean;
}

function path(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/preferences/quiet-hours`;
}

export async function getQuietHours(
  client: ApiClient,
  organizationSlug: string,
): Promise<QuietHoursView> {
  const { data } = await client.request<QuietHoursView>({ path: path(organizationSlug) });
  return data;
}

export async function getQuietHoursActive(
  client: ApiClient,
  organizationSlug: string,
): Promise<QuietHoursActiveView> {
  const { data } = await client.request<QuietHoursActiveView>({
    path: `${path(organizationSlug)}/active`,
  });
  return data;
}

export async function updateQuietHours(
  client: ApiClient,
  organizationSlug: string,
  settings: QuietHoursView,
): Promise<QuietHoursView> {
  const { data } = await client.request<QuietHoursView>({
    method: 'PUT',
    path: path(organizationSlug),
    body: settings,
  });
  return data;
}
