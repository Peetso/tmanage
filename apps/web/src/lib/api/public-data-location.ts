import type { ApiClient } from './client';

/**
 * 54-17 — where customer data lives. `GET /v1/public/site/data-location`.
 *
 * Public and tenant-less, like the trust read: it names the deployment's region and data-centre
 * label, nothing about an organization. Both the public "Where your data lives" page and the
 * organization's Data-location card read it. Paired `Exact` with the API's view in
 * `e2e/contracts/api-web-shapes.ts`.
 */
export interface PublicDataLocationView {
  readonly region: string;
  /** The operator's data-centre label; `null` when the deployment has not set one. */
  readonly regionLabel: string | null;
  /** `YYYY-MM-DD`. */
  readonly updatedOn: string;
}

export async function fetchPublicDataLocation(client: ApiClient): Promise<PublicDataLocationView> {
  const { data } = await client.request<PublicDataLocationView>({
    path: '/v1/public/site/data-location',
    authentication: 'none',
  });
  return data;
}

/** Where a residency request goes: the contact form, tagged for the lead list (54-17). */
export const REGION_REQUEST_HREF = '/contact?topic=residency_request#book-demo-form';

/**
 * The data-centre label to show: the deployment's own when set, otherwise the catalog's stand-in
 * (the design's "Europe (Hostinger)" / "أوروبا (Hostinger)").
 */
export function regionLabelOf(view: PublicDataLocationView | undefined, fallback: string): string {
  return view?.regionLabel ?? fallback;
}
