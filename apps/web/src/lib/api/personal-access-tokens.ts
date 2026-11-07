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
  /** R13 s3: the scopes the token holds (`tmanage:read` …), in canonical order. */
  readonly scopes: readonly string[];
  /** R13 s3: addresses / ranges the token may be used from; empty means any. */
  readonly ipAllowlist: readonly string[];
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

/**
 * The access a token can be given (R13 s3 / A15), in the server's canonical order. Scopes only
 * narrow: a token never does more than its member can, whatever it holds. The org's token policy
 * may refuse some of these; the server's message then says which.
 */
export const TOKEN_SCOPE_CHOICES = [
  'tmanage:read',
  'tmanage:write',
  'tmanage:manage',
  'tmanage:billing',
] as const;
export type TokenScope = (typeof TOKEN_SCOPE_CHOICES)[number];
/** The create dialog's starting point — the same read + write the server defaults to. */
export const DEFAULT_TOKEN_SCOPES: readonly TokenScope[] = ['tmanage:read', 'tmanage:write'];

/** The chosen scopes, de-duplicated, unknown words dropped, in canonical order. */
export function canonicalScopes(scopes: Iterable<string>): TokenScope[] {
  const chosen = new Set(scopes);
  return TOKEN_SCOPE_CHOICES.filter((scope) => chosen.has(scope));
}

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
  input: { name: string; expiresInDays: TokenExpiryDays; scopes: readonly TokenScope[] },
): Promise<CreatedPersonalAccessTokenView> {
  const { data } = await client.request<CreatedPersonalAccessTokenView>({
    method: 'POST',
    path: collectionPath(organizationSlug),
    body: { ...input, scopes: canonicalScopes(input.scopes) },
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
