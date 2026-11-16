import type { ApiClient } from './client';

/**
 * VERIFYMAIL — confirming the address of a password account (API: email-confirmation.controller).
 * The send is signed in and always goes to the caller's own address; the completion is public and
 * only confirms the address (no sign-in). The token travels in a body, never a query string.
 */

export interface EmailConfirmationRequestedView {
  readonly status: 'sent' | 'already_confirmed' | 'not_sent';
}

/** Mail a new confirmation link to the signed-in person's own address. */
export async function requestEmailConfirmation(
  client: ApiClient,
): Promise<EmailConfirmationRequestedView> {
  const { data } = await client.request<EmailConfirmationRequestedView>({
    method: 'POST',
    path: '/v1/email-confirmations',
  });
  return data;
}

/** Spend a link. 404 means it is used, superseded or expired. */
export async function completeEmailConfirmation(client: ApiClient, token: string): Promise<void> {
  await client.request<void>({
    method: 'POST',
    path: '/v1/email-confirmations/completions',
    body: { token },
    authentication: 'none',
  });
}
