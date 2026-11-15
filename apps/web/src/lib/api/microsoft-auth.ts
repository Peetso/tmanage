import type { ApiClient } from './client';
import { ApiRequestError } from './errors';
import type {
  GoogleAvailabilityView,
  GooglePendingMfaView,
  GoogleStartInput,
  GoogleStartView,
} from './google-auth';

/**
 * "Continue with Microsoft" (51-05) — the browser half. The API's `/v1/auth/microsoft/*` routes
 * have exactly the wire bodies of `/v1/auth/google/*` and exist only when
 * `MICROSOFT_SIGNIN_CLIENT_ID` and `MICROSOFT_SIGNIN_CLIENT_SECRET` are set; a 404 from the
 * availability probe hides the button. State, nonce and the PKCE verifier stay in the API's
 * HttpOnly cookie.
 */

/** Whether the button should show; null on 404 (not configured) and on any failure. */
export async function fetchMicrosoftAvailability(
  client: ApiClient,
): Promise<GoogleAvailabilityView | null> {
  try {
    const { data } = await client.request<GoogleAvailabilityView>({
      method: 'GET',
      path: '/v1/auth/microsoft',
      authentication: 'none',
    });
    return data.available === true ? data : null;
  } catch {
    return null;
  }
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
