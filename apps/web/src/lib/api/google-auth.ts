import type { ApiClient } from './client';
import { ApiRequestError } from './errors';

/**
 * "Continue with Google" — the browser half. The routes exist only when the API has both
 * `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`; a 404 from the availability probe hides the
 * button. The OAuth state, nonce and PKCE verifier live in an HttpOnly cookie the API sets;
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

/** Whether the button should show; false on 404 (not configured) and on any failure. */
export async function fetchGoogleAvailability(
  client: ApiClient,
): Promise<GoogleAvailabilityView | null> {
  try {
    const { data } = await client.request<GoogleAvailabilityView>({
      method: 'GET',
      path: '/v1/auth/google',
      authentication: 'none',
    });
    return data.available === true ? data : null;
  } catch {
    return null;
  }
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
