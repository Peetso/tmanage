import type { ApiClient } from './client';

/**
 * x161 — the public site's contact / lead intake, as `ContactScreen` uses it.
 *
 * Hand-written for the boundary reason `errors.ts` gives — `apps/web` may not import `@tmanage/api`.
 * The single endpoint is unauthenticated (`authentication: 'none'`): it establishes no session and
 * carries no CSRF token, matching the API's `@Public()` route.
 */

/** The request body. Ends in `Input`, so `contracts-check` treats it as request-side, not a response. */
export interface ContactSubmitInput {
  readonly name: string;
  readonly email: string;
  readonly message: string;
  /** 52-21's invisible form proof (`lib/form-proof.ts`); absent when it could not be fetched. */
  readonly startedAt?: string;
  readonly nonce?: string;
  readonly proof?: string;
}

/**
 * The acknowledgement. Deliberately opaque — it mirrors the API's `ContactSubmitView` exactly and
 * carries nothing that was stored (no id, no echoed values, no other lead).
 */
export interface ContactSubmitView {
  /** `not_sent` (52-21): refused calmly; the form shows its generic "could not send". */
  readonly status: 'received' | 'not_sent';
}

export async function submitContact(
  client: ApiClient,
  input: ContactSubmitInput,
): Promise<ContactSubmitView> {
  const { data } = await client.request<ContactSubmitView>({
    method: 'POST',
    path: '/public/site/contact',
    body: input,
    authentication: 'none',
  });
  return data;
}
