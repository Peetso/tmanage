import type { ApiClient } from './client';
import { ApiRequestError } from './errors';

/**
 * Public self-service sign-up, as `/sign-up` uses it. Hand-written for the boundary reason
 * `errors.ts` gives. Both routes are unauthenticated and exist only while the API's
 * `PUBLIC_SIGNUP` switch is on; with it off they answer 404.
 */

/** GET /v1/public/sign-up — present only while sign-up is open. Mirrors the API view exactly. */
export interface PublicSignupAvailabilityView {
  readonly available: true;
}

/** The request body. Ends in `Input`, so `contracts-check` treats it as request-side. */
export interface PublicSignupInput {
  readonly displayName: string;
  readonly email: string;
  readonly password: string;
  readonly organizationName: string;
  readonly timezone: string;
  readonly defaultLocale: string;
  /** The honeypot; a person never sees or fills it. */
  readonly website: string;
  /** 52-21's invisible form proof (`lib/form-proof.ts`); absent when it could not be fetched. */
  readonly startedAt?: string;
  readonly nonce?: string;
  readonly proof?: string;
  /** PLANWEB: the plan picked on the pricing page (an id only; the API checks it). */
  readonly plan?: string;
  /** REFERRAL (57-08): the invite code from `?ref=` (a code only; the API checks it). */
  readonly referral?: string;
}

/** The new owner's session, already issued (cookies set by the response). */
export interface PublicSignupView {
  readonly status: 'authenticated';
  readonly csrfToken: string;
  readonly expiresAt: string;
  readonly organizationSlug: string;
  /** PLANWEB: the checked plan from the pricing page, or `null` (always `null` in the beta). */
  readonly planId: string | null;
}

/** True when sign-up is open. 404 (switch off) resolves to false; anything else rethrows. */
export async function fetchSignupAvailability(client: ApiClient): Promise<boolean> {
  try {
    const { data } = await client.request<PublicSignupAvailabilityView>({
      method: 'GET',
      path: '/v1/public/sign-up',
      authentication: 'none',
    });
    return data.available === true;
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) return false;
    throw error;
  }
}

export async function signUp(
  client: ApiClient,
  input: PublicSignupInput,
): Promise<PublicSignupView> {
  const { data } = await client.request<PublicSignupView>({
    method: 'POST',
    path: '/v1/public/sign-up',
    body: input,
    authentication: 'none',
  });
  return data;
}
