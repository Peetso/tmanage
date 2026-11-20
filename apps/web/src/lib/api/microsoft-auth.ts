import type { ApiClient } from './client';
import { ApiRequestError } from './errors';
import { fetchProviderAvailability, type ProviderAvailability } from './provider-availability';
import type { GooglePendingMfaView, GoogleStartInput, GoogleStartView } from './google-auth';

/**
 * "Continue with Microsoft" (51-05) — the browser half. The API's `/v1/auth/microsoft/*` routes
 * have exactly the wire bodies of `/v1/auth/google/*` and exist only when
 * `MICROSOFT_SIGNIN_CLIENT_ID` and `MICROSOFT_SIGNIN_CLIENT_SECRET` are set; without them the
 * availability probe answers `{ available: false }` and the button stays hidden. State, nonce
 * and the PKCE verifier stay in the API's HttpOnly cookie.
 */

/** `GET /v1/auth/microsoft` on a deployment without Microsoft sign-in keys. */
export interface MicrosoftUnavailableView {
  readonly available: false;
}

/** available / unavailable (`{ available: false }` or 404) / unknown (no definite answer; HT-3). */
export function fetchMicrosoftAvailability(client: ApiClient): Promise<ProviderAvailability> {
  return fetchProviderAvailability(client, '/v1/auth/microsoft');
}

export async function startMicrosoft(client: ApiClient, input: GoogleStartInput): Promise<string> {
  const { data } = await client.request<GoogleStartView>({
    method: 'POST',
    path: '/v1/auth/microsoft/start',
    body: input,
    authentication: 'none',
  });
  return data.url;
}

/** The parked second-factor challenge, once; null when there is none. */
export async function takeMicrosoftPendingMfa(
  client: ApiClient,
): Promise<GooglePendingMfaView | null> {
  try {
    const { data } = await client.request<GooglePendingMfaView>({
      method: 'POST',
      path: '/v1/auth/microsoft/mfa',
      authentication: 'none',
    });
    return data;
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) return null;
    throw error;
  }
}
