import type { ApiClient } from './client';

/**
 * The public legal documents — module 1 (x188). `GET /v1/public/site/legal/:doc`.
 *
 * Public and tenant-less: no session, no organization slug, no capability. The read discloses
 * nothing tenant-specific — it is code-defined copy — so it is sent with `authentication: 'none'`,
 * which keeps a 401 (there should never be one here) from being mistaken for an expired session and
 * triggering a refresh.
 *
 * The shape is paired `Exact` with the API's `PublicLegalView`
 * (`apps/api/src/modules/public-site/public-content.service.ts`) in
 * `e2e/contracts/api-web-shapes.ts`, so the terms the screen renders cannot drift from the terms the
 * API serves. `LegalDoc` and the section shape are object-literal `type` aliases rather than exported
 * interfaces on purpose: the contracts gate enumerates every exported web interface as a response
 * projection to pair, and only the top-level `PublicLegalView` is the response here.
 */

/** The two legal documents the public site serves — a closed allowlist mirrored from the API. */
export type LegalDoc = 'terms' | 'privacy';

/** One section of a legal document. `id` is the DOM anchor and the anchor-nav target. */
export type LegalSection = {
  readonly id: string;
  readonly heading: string;
  readonly body: string;
};

/** The public legal view. Paired Exact with the API projection of the same name. */
export interface PublicLegalView {
  readonly doc: LegalDoc;
  readonly title: string;
  readonly effectiveDate: string;
  readonly intro: string;
  readonly sections: readonly LegalSection[];
}

export async function fetchPublicLegal(client: ApiClient, doc: LegalDoc): Promise<PublicLegalView> {
  const { data } = await client.request<PublicLegalView>({
    path: `/v1/public/site/legal/${doc}`,
    authentication: 'none',
  });
  return data;
}
