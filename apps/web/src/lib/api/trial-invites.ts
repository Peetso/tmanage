import type { ApiClient } from './client';

/**
 * LANE-Q — the personal trial link (`/sign-up?trial=<token>`). `GET /v1/public/trial-invites/:token`
 * answers the company and work address it was sent for, so the sign-up form can be pre-filled;
 * any other answer (expired, used, tampered) is a 404 and the visitor signs up like anyone else.
 * The token names no person: it is a row id, an expiry and a signature. Paired Exact with the API
 * view in `e2e/contracts/api-web-shapes.ts`.
 */

export interface TrialInviteView {
  readonly company: string;
  readonly email: string;
  readonly language: 'en' | 'ar';
}

const TOKEN_SHAPE = /^v1\.[A-Za-z0-9._-]{20,200}$/u;

/** The `?trial=` value when it has the token's shape, else `null` (nothing is fetched). */
export function trialTokenFromQuery(raw: string | null): string | null {
  const value = (raw ?? '').trim();
  return TOKEN_SHAPE.test(value) ? value : null;
}

/** The pre-fill, or `null` when the link cannot be used (any error: never blocks sign-up). */
export async function fetchTrialInvite(
  client: ApiClient,
  token: string,
): Promise<TrialInviteView | null> {
  try {
    const { data } = await client.request<TrialInviteView>({
      method: 'GET',
      path: `/v1/public/trial-invites/${encodeURIComponent(token)}`,
      authentication: 'none',
    });
    return data;
  } catch {
    return null;
  }
}
