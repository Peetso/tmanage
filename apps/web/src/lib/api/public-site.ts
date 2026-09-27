import type { ApiClient } from './client';

/**
 * The public & trust site endpoints — module 1's marketing home content.
 *
 * `GET /v1/public/site/home` is a `@Public()` read on the API: no session, no organization, no
 * capability. It takes no request body and returns the same deterministic payload for every
 * visitor — hero copy, the feature blurbs, and the two call-to-action targets. Nested shapes are
 * inlined so `PublicHome` is the single response projection paired with the API's `PublicHomeView`
 * in `e2e/contracts/api-web-shapes.ts`.
 */
export interface PublicHome {
  readonly hero: {
    readonly title: string;
    readonly subtitle: string;
    readonly primaryCta: { readonly label: string; readonly href: string };
    readonly secondaryCta: { readonly label: string; readonly href: string };
  };
  readonly features: readonly {
    readonly title: string;
    readonly body: string;
  }[];
}

export async function getPublicHome(client: ApiClient): Promise<PublicHome> {
  const { data } = await client.request<PublicHome>({ path: '/v1/public/site/home' });
  return data;
}

/**
 * The public status page's read — Public & trust site, module 1 (x159).
 *
 * `GET /v1/public/site/status` is the one endpoint this application reaches with no session and no
 * organization: the status page is read by anyone, including a person who is not signed in. So the
 * request declares `authentication: 'none'` — a 401 here would be about the request, never a reason
 * to refresh a session the reader does not have.
 *
 * The shapes below are paired Exact with the API's `PublicStatusView` / `PublicIncidentView` in
 * `e2e/contracts/api-web-shapes.ts`; a field renamed on either side is a compile error there.
 */

/** The incident lifecycle, the same closed vocabulary the API's `INCIDENT_STATUSES` declares. */
export type IncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved';

/** One published incident, as the public page renders it. */
export interface PublicIncidentView {
  readonly id: string;
  readonly component: string;
  readonly status: IncidentStatus;
  readonly title: string;
  readonly body: string;
  readonly startedAt: string;
  readonly resolvedAt: string | null;
  readonly createdAt: string;
}

/** The status page's response: the overall banner state and the recent published incidents. */
export interface PublicStatusView {
  readonly overall: 'operational' | 'investigating' | 'identified' | 'monitoring';
  readonly incidents: readonly PublicIncidentView[];
  readonly asOf: string;
}

export async function fetchPublicStatus(client: ApiClient): Promise<PublicStatusView> {
  const { data } = await client.request<PublicStatusView>({
    path: '/v1/public/site/status',
    // No session is involved: this is a public page, read before any sign-in.
    authentication: 'none',
  });
  return data;
}
