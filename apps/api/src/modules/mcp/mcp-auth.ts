import { createHash } from 'node:crypto';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { RequestState } from '../../common/http/request-state.js';
import {
  OAUTH_GRANT_BOOTSTRAP_REASON,
  OAUTH_IDENTITY_TABLES,
  OauthTokensRepository,
} from '../oauth/oauth-tokens.repository.js';
import { SCOPE_PLATFORM, SCOPE_READ, insufficientScopeChallenge } from '../oauth/scopes.js';
import { findOauthClientName } from './mcp-oauth-clients.repository.js';

/**
 * **`/mcp` as an OAuth 2.1 protected resource — plan §4.1, MCP authorization.**
 *
 * Three pieces the session guard, the exception filter and the MCP endpoint share:
 *
 * 1. **The challenge.** A refused `/mcp` request carries `WWW-Authenticate` naming the
 *    protected-resource metadata, so a client can discover the authorization server from the 401
 *    alone; a call outside the grant's scopes gets the 403 `insufficient_scope` step-up challenge.
 *    The URLs come from configuration (`API_PUBLIC_URL`), never from a `Host` header.
 * 2. **The access-token check.** An opaque access token minted by `/oauth/token` is accepted at
 *    `/mcp` only while it is live (not expired, not revoked), its audience is exactly this
 *    resource, and its grant is still in force. A token for another resource is refused.
 * 3. **The hand-off.** What the token proved — grant, member, organization, scopes and client —
 *    travels from the guard to the endpoint on a module-private map keyed by the request state, so
 *    only the guard's OAuth branch can produce it and nothing on the request can forge it.
 */

/** The canonical public origin — the same rule `OAuthModule` uses for the issuer. */
export function mcpIssuerOrigin(config: {
  readonly apiPublicUrl?: string | undefined;
  readonly webPublicUrl?: string | undefined;
}): string {
  const source = config.apiPublicUrl ?? config.webPublicUrl;
  if (source === undefined || source === '') return 'http://localhost';
  try {
    return new URL(source).origin;
  } catch {
    return 'http://localhost';
  }
}

/** The canonical resource URI (`<origin>/mcp`) every access token's audience must equal. */
export function mcpResourceUri(config: Parameters<typeof mcpIssuerOrigin>[0]): string {
  return `${mcpIssuerOrigin(config)}/mcp`;
}

/** The RFC 9728 protected-resource metadata URL for `/mcp`. */
export function mcpResourceMetadataUrl(config: Parameters<typeof mcpIssuerOrigin>[0]): string {
  return `${mcpIssuerOrigin(config)}/.well-known/oauth-protected-resource/mcp`;
}

/** Whether a request URL is the MCP endpoint (`/mcp`, `/mcp/`, with or without a query). */
export function isMcpPath(url: unknown): boolean {
  return typeof url === 'string' && /^\/mcp\/?(?:\?.*)?$/.test(url);
}

/** An {@link ApiError} that also carries the `WWW-Authenticate` challenge the filter sets. */
export class McpChallengeError extends ApiError {
  constructor(
    status: 401 | 403,
    readonly wwwAuthenticate: string,
    auditCode: string,
  ) {
    super(
      status,
      status === 401 ? 'unauthenticated' : 'forbidden',
      status === 401 ? MESSAGES.unauthenticated : MESSAGES.forbidden,
      undefined,
      auditCode,
    );
    this.name = 'McpChallengeError';
  }
}

/** The `/mcp` 401: `Bearer resource_metadata="<PRM URL>", scope="tmanage:read"` (plan §4.1). */
export function mcpUnauthenticated(
  config: Parameters<typeof mcpIssuerOrigin>[0],
  auditCode: string,
): McpChallengeError {
  return new McpChallengeError(
    401,
    `Bearer resource_metadata="${mcpResourceMetadataUrl(config)}", scope="${SCOPE_READ}"`,
    auditCode,
  );
}

/** The `/mcp` 403 for a call the grant's scopes do not cover (T-SCP-01). */
export function mcpInsufficientScope(
  config: Parameters<typeof mcpIssuerOrigin>[0],
  grantedScopes: string,
  required: string,
): McpChallengeError {
  const challenge = insufficientScopeChallenge({
    grantedScopes,
    required,
    resourceMetadataUrl: mcpResourceMetadataUrl(config),
  });
  return new McpChallengeError(
    challenge.status,
    challenge.wwwAuthenticate,
    'mcp_insufficient_scope',
  );
}

/** What a live OAuth access token proved. Every field comes from the token and grant rows. */
export interface McpOAuthAccess {
  readonly grantId: string;
  readonly userId: string;
  readonly membershipId: string;
  readonly organizationId: string;
  /** Space-delimited OAuth scopes: the token's, narrowed to what the grant still holds. */
  readonly scopes: string;
  readonly clientId: string;
  readonly clientName: string;
  /**
   * ADR-0015 F1: the grant's platform binding, present only when it holds `tmanage:platform` and
   * recorded a consent step-up session. The endpoint still checks the window end on every call.
   */
  readonly platform?: { readonly stepUpSessionId: string; readonly until: number };
}

const oauthAccessByRequest = new WeakMap<RequestState, McpOAuthAccess>();

/** Set by `SessionAuthGuard`'s OAuth branch only. */
export function recordMcpOAuthAccess(state: RequestState, access: McpOAuthAccess): void {
  oauthAccessByRequest.set(state, access);
}

/** Read by the MCP endpoint: present only when the guard authenticated an OAuth access token. */
export function mcpOAuthAccessFor(state: RequestState): McpOAuthAccess | undefined {
  return oauthAccessByRequest.get(state);
}

/** A presented OAuth access token that does not authenticate. The code goes to the audit log. */
export class McpOAuthNotAuthenticatedError extends Error {
  constructor(readonly code: string) {
    super(`OAuth access token not accepted: ${code}`);
    this.name = 'McpOAuthNotAuthenticatedError';
  }
}

/** The injection token for the authenticator `SessionAuthGuard` uses on `/mcp`. */
export const MCP_OAUTH_AUTHENTICATOR = Symbol.for('tmanage.McpOAuthAuthenticator');

export interface McpOAuthTokenAuthenticator {
  authenticate(token: string, correlationId: string): Promise<McpOAuthAccess>;
}

/** Validates an access token through `findLiveAccessTokenByHash` and its grant (plan §4.1). */
export class McpOAuthAuthenticator implements McpOAuthTokenAuthenticator {
  constructor(
    private readonly database: TenantDatabase,
    private readonly resourceUri: string,
    private readonly repo: OauthTokensRepository = new OauthTokensRepository(),
  ) {}

  async authenticate(token: string, correlationId: string): Promise<McpOAuthAccess> {
    const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
    const row = await this.database.identityRead(
      { correlationId, tables: [...OAUTH_IDENTITY_TABLES] },
      (db) => this.repo.findLiveAccessTokenByHash(db, tokenHash),
    );
    if (!row) throw new McpOAuthNotAuthenticatedError('oauth_token_unknown');
    if (row.audience !== this.resourceUri) {
      throw new McpOAuthNotAuthenticatedError('oauth_token_wrong_audience');
    }
    const grant = await this.database.bootstrapRead(
      { correlationId, reason: OAUTH_GRANT_BOOTSTRAP_REASON, tables: ['oauth_grants'] },
      (db) => this.repo.findGrantById(db, row.grantId),
    );
    if (!grant || grant.revokedAt !== null) {
      throw new McpOAuthNotAuthenticatedError('oauth_grant_revoked');
    }
    const clientName = await this.database.identityRead(
      { correlationId, tables: ['oauth_clients'] },
      (db) => findOauthClientName(db, grant.clientPk),
    );
    const held = new Set(grant.scopes.split(/\s+/));
    const platform =
      held.has(SCOPE_PLATFORM) &&
      typeof grant.platformStepUpSessionId === 'string' &&
      grant.platformStepUpSessionId !== '' &&
      grant.platformUntil instanceof Date
        ? { stepUpSessionId: grant.platformStepUpSessionId, until: grant.platformUntil.getTime() }
        : undefined;
    return {
      grantId: grant.id,
      userId: grant.userId,
      membershipId: grant.membershipId,
      organizationId: grant.organizationId,
      scopes: row.scopes
        .split(/\s+/)
        .filter((scope) => scope !== '' && held.has(scope))
        .join(' '),
      clientId: grant.clientPk,
      clientName: clientName ?? 'AI app',
      ...(platform !== undefined ? { platform } : {}),
    };
  }
}
