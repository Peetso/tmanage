import type { ApiClient } from './client';

/**
 * Personal access tokens (module 20 Preferences → Security) — the caller's own API credentials
 * for the TManage MCP server and any other programmatic client. Behind `work.read` on the server
 * (the internal-read capability the accessibility and notification preferences reuse); the tenant
 * is the slug in the path resolved against the caller's membership, and the *member* is the
 * authenticated principal, never a value this client supplies — so it can only ever read, create
 * or revoke the caller's own tokens.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired with the API projection in the
 * `e2e/contracts` shape check so the two shapes cannot drift.
 */

/** One token as the list and revoke routes return it. The secret is never here — only the hint. */
export interface PersonalAccessTokenView {
  readonly id: string;
  readonly name: string;
  readonly tokenPrefix: string;
  readonly lastUsedAt: string | null;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

/** The create response: the view plus the plaintext, returned exactly once. */
export interface CreatedPersonalAccessTokenView extends PersonalAccessTokenView {
  readonly token: string;
}

/**
 * The expiry choices the Access tokens page offers (t2-d). Every token expires: the client never
 * sends `null`, even though the route still accepts it for older callers.
 */
export const TOKEN_EXPIRY_CHOICES = [30, 90, 365] as const;
export type TokenExpiryDays = (typeof TOKEN_EXPIRY_CHOICES)[number];
export const DEFAULT_TOKEN_EXPIRY: TokenExpiryDays = 90;

/** How a token reads on the page: in use, close to its end (seven days or less), or finished. */
export type TokenStatus = 'active' | 'expiring' | 'expired' | 'revoked';

const EXPIRING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function tokenStatus(token: PersonalAccessTokenView, now: Date): TokenStatus {
  if (token.revokedAt !== null) return 'revoked';
  if (token.expiresAt === null) return 'active';
  const left = new Date(token.expiresAt).getTime() - now.getTime();
  if (left <= 0) return 'expired';
  return left <= EXPIRING_WINDOW_MS ? 'expiring' : 'active';
}

function collectionPath(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/me/personal-access-tokens`;
}

export async function listPersonalAccessTokens(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly PersonalAccessTokenView[]> {
  const { data } = await client.request<{ tokens: readonly PersonalAccessTokenView[] }>({
    path: collectionPath(organizationSlug),
  });
  return data.tokens;
}

export async function createPersonalAccessToken(
  client: ApiClient,
  organizationSlug: string,
  input: { name: string; expiresInDays: TokenExpiryDays },
): Promise<CreatedPersonalAccessTokenView> {
  const { data } = await client.request<CreatedPersonalAccessTokenView>({
    method: 'POST',
    path: collectionPath(organizationSlug),
    body: input,
  });
  return data;
}

export async function revokePersonalAccessToken(
  client: ApiClient,
  organizationSlug: string,
  tokenId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${collectionPath(organizationSlug)}/${encodeURIComponent(tokenId)}`,
  });
}
