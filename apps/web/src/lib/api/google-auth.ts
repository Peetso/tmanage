import type { ApiClient } from './client';
import { ApiRequestError } from './errors';
import { fetchProviderAvailability, type ProviderAvailability } from './provider-availability';

/**
 * "Continue with Google" — the browser half. The routes exist only when the API has both
 * `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`; a 404 from the availability probe hides the
 * button, and no answer (5xx, timeout) keeps it as `unknown` (HT-3). The OAuth state, nonce and PKCE verifier live in an HttpOnly cookie the API sets;
 * nothing here ever sees them.
 */

/** GET /v1/auth/google. Mirrors the API view exactly. */
export interface GoogleAvailabilityView {
  readonly available: true;
  readonly signUp: boolean;
}

/** POST /v1/auth/google/start — where to send the browser. */
export interface GoogleStartView {
  readonly url: string;
}

/** POST /v1/auth/google/mfa — the second-factor challenge a Google sign-in parked. */
export interface GooglePendingMfaView {
  readonly status: 'mfa_required';
  readonly challengeToken: string;
  readonly expiresAt: string;
  readonly factors: readonly {
    readonly id: string;
    readonly kind: string;
    readonly label: string;
  }[];
  readonly returnTo: string;
}

export type GoogleIntent = 'sign-in' | 'sign-up' | 'invitation';

export interface GoogleStartInput {
  readonly intent: GoogleIntent;
  readonly invitationToken?: string;
  readonly organizationName?: string;
}

/** available / unavailable (404, not configured) / unknown (no definite answer; HT-3). */
export function fetchGoogleAvailability(client: ApiClient): Promise<ProviderAvailability> {
  return fetchProviderAvailability(client, '/v1/auth/google');
}

export async function startGoogle(client: ApiClient, input: GoogleStartInput): Promise<string> {
  const { data } = await client.request<GoogleStartView>({
    method: 'POST',
    path: '/v1/auth/google/start',
    body: input,
    authentication: 'none',
  });
  return data.url;
}

/** The parked challenge, once; null when there is none (expired, already taken). */
export async function takeGooglePendingMfa(
  client: ApiClient,
): Promise<GooglePendingMfaView | null> {
  try {
    const { data } = await client.request<GooglePendingMfaView>({
      method: 'POST',
      path: '/v1/auth/google/mfa',
      authentication: 'none',
    });
    return data;
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) return null;
    throw error;
  }
}
