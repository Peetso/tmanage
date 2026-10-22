import type { ApiClient } from './client';

/**
 * The public FAQ page — module 1 (x186). `GET /v1/public/site/faq`.
 *
 * Public and tenant-less: no session, no organization slug, no capability. The read authenticates
 * by nothing because it discloses nothing tenant-specific — it is code-defined grouped Q&A copy —
 * so it is sent with `authentication: 'none'`, which keeps a 401 (there should never be one here)
 * from being mistaken for an expired session and triggering a refresh.
 *
 * The shape is paired `Exact` with the API's `PublicFaqView`
 * (`apps/api/src/modules/public-site/faq.service.ts`) in `e2e/contracts/api-web-shapes.ts`, so the
 * copy the screen renders cannot drift from the copy the API serves. The nested shapes are
 * object-literal `type` aliases rather than exported interfaces on purpose: the contracts gate
 * enumerates every exported web interface as a response projection to pair, and only the top-level
 * `PublicFaqView` is the response here.
 */

/** One question and its answer within a group. */
export type FaqItem = {
  readonly id: string;
  readonly question: string;
  readonly answer: string;
};

/** A titled group of related questions — one accordion section. */
export type FaqGroup = {
  readonly id: string;
  readonly title: string;
  readonly items: readonly FaqItem[];
};

/** The public FAQ view. Paired Exact with the API projection of the same name. */
export interface PublicFaqView {
  readonly groups: readonly FaqGroup[];
}

/** The FAQ copy language for a display locale: Arabic for `ar-*`, English for everything else. */
export function faqLanguageOf(locale: string | undefined): 'en' | 'ar' {
  return locale?.split('-')[0]?.toLowerCase() === 'ar' ? 'ar' : 'en';
}

/**
 * Reads the FAQ in the language of `locale` (the active display locale, e.g. `ar-EG`). The language
 * travels as `?lang=` — explicit, so it does not depend on the browser's `Accept-Language` — and
 * the API answers English for anything outside its allowlist.
 */
export async function fetchPublicFaq(client: ApiClient, locale?: string): Promise<PublicFaqView> {
  const { data } = await client.request<PublicFaqView>({
    path: `/v1/public/site/faq?lang=${faqLanguageOf(locale)}`,
    authentication: 'none',
  });
  return data;
}
