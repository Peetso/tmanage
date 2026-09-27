import type { ApiClient } from './client';

/**
 * The public security-and-trust page — module 1 (x158). `GET /v1/public/site/trust`.
 *
 * Public and tenant-less: no session, no organization slug, no capability. The read authenticates
 * by nothing because it discloses nothing tenant-specific — it is code-defined copy about the
 * product’s security posture — so it is sent with `authentication: 'none'`, which keeps a 401
 * (there should never be one here) from being mistaken for an expired session and triggering a
 * refresh.
 *
 * The shape is paired `Exact` with the API’s `PublicTrustView`
 * (`apps/api/src/modules/public-site/trust-content.service.ts`) in `e2e/contracts/api-web-shapes.ts`,
 * so the copy the screen renders cannot drift from the copy the API serves. The nested shapes are
 * object-literal `type` aliases rather than exported interfaces on purpose: the contracts gate
 * enumerates every exported web interface as a response projection to pair, and only the top-level
 * `PublicTrustView` is the response here.
 */

/** One group of related controls — access, encryption, resilience. */
export type TrustControlSection = {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly controls: readonly string[];
};

/** A third party that processes data on TManage’s behalf. */
export type TrustSubprocessor = {
  readonly name: string;
  readonly purpose: string;
  readonly location: string;
};

/** The public trust view. Paired Exact with the API projection of the same name. */
export interface PublicTrustView {
  readonly controls: readonly TrustControlSection[];
  readonly dataHandling: readonly string[];
  readonly subprocessors: readonly TrustSubprocessor[];
  readonly compliance: readonly string[];
  readonly statusPath: string;
}

export async function fetchPublicTrust(client: ApiClient): Promise<PublicTrustView> {
  const { data } = await client.request<PublicTrustView>({
    path: '/v1/public/site/trust',
    authentication: 'none',
  });
  return data;
}
