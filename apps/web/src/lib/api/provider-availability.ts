import type { ApiClient } from './client';
import { ApiRequestError } from './errors';
import type { GoogleAvailabilityView } from './google-auth';

/**
 * HT-3 (no silent collapse) for the "Continue with Google / Microsoft" probes: only a definite
 * answer hides a button. `unavailable` is a 2xx `{ available: false }` or a 404 (the routes do not
 * exist without the provider's keys). Anything else — no answer, a timeout, a 5xx, a 429, any
 * other status — is `unknown`, exactly as the session check treats a non-401 (`session-check.ts`):
 * the button stays, a click is the retry, and the probe runs again on the session check's
 * schedule (`retryDelay`).
 */
export type ProviderAvailability =
  | { readonly state: 'available'; readonly view: GoogleAvailabilityView }
  | { readonly state: 'unavailable' }
  | { readonly state: 'unknown' };

const UNAVAILABLE: ProviderAvailability = { state: 'unavailable' };
const UNKNOWN: ProviderAvailability = { state: 'unknown' };

export async function fetchProviderAvailability(
  client: ApiClient,
  path: '/v1/auth/google' | '/v1/auth/microsoft',
): Promise<ProviderAvailability> {
  try {
    const { data } = await client.request<GoogleAvailabilityView | { readonly available: false }>({
      method: 'GET',
      path,
      authentication: 'none',
    });
    return data.available === true ? { state: 'available', view: data } : UNAVAILABLE;
  } catch (error) {
    return error instanceof ApiRequestError && error.status === 404 ? UNAVAILABLE : UNKNOWN;
  }
}

/** The button is offered when the provider is available, or when that is not known yet. */
export function providerOffered(
  availability: ProviderAvailability | null,
  purpose: 'sign-in' | 'sign-up' = 'sign-in',
): boolean {
  if (availability === null) return false;
  if (availability.state === 'unknown') return true;
  if (availability.state === 'unavailable') return false;
  return purpose === 'sign-in' || availability.view.signUp;
}
