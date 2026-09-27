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
