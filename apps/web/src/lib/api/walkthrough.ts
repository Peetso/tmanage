import type { ApiClient } from './client';

/**
 * LANE-Q — "Book a walkthrough" (`POST /v1/public/walkthrough-requests`), as `WalkthroughForm`
 * uses it. Unauthenticated (`authentication: 'none'`): it establishes no session and carries no
 * CSRF token, matching the API's `@Public()` route. The API re-checks every field.
 */

/** The request body. Ends in `Input`, so `contracts-check` treats it as request-side. */
export interface WalkthroughSubmitInput {
  readonly name: string;
  readonly email: string;
  readonly company: string;
  readonly teamSize: string;
  /** The visitor's IANA time zone; the three times are wall-clock values in it. */
  readonly timeZone: string;
  /** Three `YYYY-MM-DDTHH:MM` values, first choice first. */
  readonly slots: readonly string[];
  readonly topics: readonly string[];
  readonly consent: boolean;
  readonly language: 'en' | 'ar';
  /** The page address's `utm_source` (NOCOOKIE: read from the URL, never stored on the device). */
  readonly source?: string;
  /** OUTREACH MANAGER: a campaign mail's signed invite (the API verifies it). */
  readonly invite?: string;
  /** The honeypot: always empty from a person. */
  readonly website: string;
  readonly startedAt?: string;
  readonly nonce?: string;
  readonly proof?: string;
}

/** The acknowledgement: a reference to quote, nothing that was stored. */
export interface WalkthroughSubmitView {
  readonly reference: string;
}

export async function submitWalkthrough(
  client: ApiClient,
  input: WalkthroughSubmitInput,
): Promise<WalkthroughSubmitView> {
  const { data } = await client.request<WalkthroughSubmitView>({
    method: 'POST',
    path: '/v1/public/walkthrough-requests',
    body: input,
    authentication: 'none',
  });
  return data;
}
