import type { ApiClient } from './client';

/**
 * Self-service password reset — ID-05 (walkthrough ACC-02). Both routes are public: the person
 * is locked out. The token travels in a body, never a query string.
 */

export interface PasswordResetRequestedView {
  readonly status: 'requested';
}

/** Ask for a link. The answer is the same whether or not the address has an account. */
export async function requestPasswordReset(
  client: ApiClient,
  email: string,
): Promise<PasswordResetRequestedView> {
  const { data } = await client.request<PasswordResetRequestedView>({
    method: 'POST',
    path: '/v1/password-resets',
    body: { email },
    authentication: 'none',
  });
  return data;
}

/** Spend a link on a new password. 404 means the link is used, superseded or expired. */
export async function completePasswordReset(
  client: ApiClient,
  token: string,
  password: string,
): Promise<void> {
  await client.request<void>({
    method: 'POST',
    path: '/v1/password-resets/completions',
    body: { token, password },
    authentication: 'none',
  });
}
