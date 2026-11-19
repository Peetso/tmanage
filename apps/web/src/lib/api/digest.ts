import type { ApiClient } from './client';

/**
 * PREF-DIGEST notification digest cadence (module 20, x245) — the caller's own digest-frequency
 * preference, read and replaced. Behind `work.read` on the server (the internal-read capability the
 * sibling preferences slices reuse); a caller without it gets the ordinary 403 the shared client
 * turns into an error. The tenant is the slug in the path resolved against the caller's membership,
 * and the *member* is the authenticated principal — never a value this client supplies — so it can
 * only ever read or write the caller's own row.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired with the API projection in the
 * `e2e/contracts` shape check so the two shapes cannot drift.
 */

/** The cadences a digest may be delivered on — the closed vocabulary the API enforces. */
export type DigestCadence = 'immediate' | 'daily' | 'weekly';

/** The whole digest cadence the GET/PUT route exchanges. Paired Exact with the API view. */
export interface DigestPrefView {
  readonly cadence: DigestCadence;
  readonly sendHour: number;
  readonly dayOfWeek: number;
  /** 62-A1c: the business briefing as a section of this mail; off by default, one per person. */
  readonly businessBriefing: boolean;
}

function path(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/preferences/digest`;
}

export async function getDigestPreference(
  client: ApiClient,
  organizationSlug: string,
): Promise<DigestPrefView> {
  const { data } = await client.request<DigestPrefView>({ path: path(organizationSlug) });
  return data;
}

export async function updateDigestPreference(
  client: ApiClient,
  organizationSlug: string,
  settings: DigestPrefView,
): Promise<DigestPrefView> {
  const { data } = await client.request<DigestPrefView>({
    method: 'PUT',
    path: path(organizationSlug),
    body: settings,
  });
  return data;
}
