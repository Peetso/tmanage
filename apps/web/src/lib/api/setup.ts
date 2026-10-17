import type { ApiClient } from './client';
import { ApiRequestError } from './errors';

/**
 * First-owner setup — how a fresh install creates its first organisation owner, as the `/setup`
 * screen uses it. There is no public sign-up, so this is the only way in on an empty database.
 *
 * Hand-written for the boundary reason `errors.ts` gives — `apps/web` may not import `@tmanage/api`.
 * Both endpoints are unauthenticated (`authentication: 'none'`), matching the API's `@Public()`
 * routes. The API answers 404 to both unless `SETUP_TOKEN` is configured and no organisation
 * exists yet, so "not configured" and "already done" look the same from here — deliberately.
 *
 * The setup token travels only in the POST body, never in a URL or query string, so it does not
 * land in access logs, browser history or a `Referer` header.
 */

/** GET /public/setup — present only while setup is open. Mirrors the API view exactly. */
export interface FirstOwnerAvailabilityView {
  readonly available: true;
}

/** The request body. Ends in `Input`, so `contracts-check` treats it as request-side, not a response. */
export interface FirstOwnerSetupInput {
  readonly setupToken: string;
  readonly email: string;
  readonly displayName: string;
  readonly password: string;
  readonly organizationName: string;
  readonly slug: string;
  readonly timezone: string;
  readonly defaultLocale: string;
}

/**
 * The new owner's session, already issued: the cookie is set by the response, and this carries
 * only what the client needs next — the CSRF token, when the session ends, and where to go.
 */
export interface FirstOwnerSetupView {
  readonly status: 'authenticated';
  readonly csrfToken: string;
  readonly expiresAt: string;
  readonly organizationSlug: string;
}

/**
 * True when setup is open. A 404 means setup is not configured or has already been done, so it
 * resolves to false; any other failure (network, 5xx, rate limit) rethrows for the screen to show.
 */
export async function fetchSetupAvailability(client: ApiClient): Promise<boolean> {
  try {
    const { data } = await client.request<FirstOwnerAvailabilityView>({
      method: 'GET',
      path: '/public/setup',
      authentication: 'none',
    });
    return data.available === true;
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) return false;
    throw error;
  }
}

export async function completeFirstOwnerSetup(
  client: ApiClient,
  input: FirstOwnerSetupInput,
): Promise<FirstOwnerSetupView> {
  const { data } = await client.request<FirstOwnerSetupView>({
    method: 'POST',
    path: '/public/setup',
    body: input,
    authentication: 'none',
  });
  return data;
}
