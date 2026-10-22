import { Inject, Injectable, Optional } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiError, MESSAGES } from '../errors.js';
import { IS_PUBLIC } from '../decorators.js';
import { requireRequestState } from '../request-state.js';
import {
  API_CONFIG,
  AUTHENTICATION_EVENT_RECORDER,
  PERSONAL_ACCESS_TOKEN_AUTHENTICATOR,
  SESSION_SERVICE,
} from '../tokens.js';
import type { ApiConfig } from '../api-config.js';
import { GUARD_REFUSAL_ACTIONS, GUARD_REFUSAL_REASONS } from '../authentication-event-recorder.js';
import type { AuthenticationEventRecorder } from '../authentication-event-recorder.js';
import { SessionNotAuthenticatedError } from '../../../modules/identity/session.service.js';
import type { SessionService } from '../../../modules/identity/session.service.js';
import { readCookie } from '../../../modules/identity/session-token.js';
import { PersonalAccessTokenNotAuthenticatedError } from '../../../modules/personal-access-tokens/personal-access-tokens.service.js';
import type { PersonalAccessTokensService } from '../../../modules/personal-access-tokens/personal-access-tokens.service.js';
import {
  INTERNAL_GRANT_HEADER,
  internalGrants,
  isInProcessRequest,
} from '../../../modules/mcp/internal-grant.js';
import type { InternalGrantStore } from '../../../modules/mcp/internal-grant.js';
import { TOKEN_PREFIX } from '../../../modules/personal-access-tokens/personal-access-token.js';
import {
  MCP_OAUTH_AUTHENTICATOR,
  McpOAuthNotAuthenticatedError,
  isMcpPath,
  mcpUnauthenticated,
  recordMcpOAuthAccess,
} from '../../../modules/mcp/mcp-auth.js';
import type { McpOAuthTokenAuthenticator } from '../../../modules/mcp/mcp-auth.js';

/**
 * Spec §3 step 1 — "authenticate the current session and validate revocation/cutoff".
 *
 * The guard is a thin adapter over `SessionService.authenticate()`, which already does the
 * work: verify the access token's HMAC, then **read the session row**, because 04 §3 requires
 * immediate server-side revocation and a token trusted on its signature alone stays valid
 * until it expires. Nothing about that decision is re-litigated here.
 *
 * What this layer adds is the translation, and the translation is where information leaks if
 * it is careless. `SessionNotAuthenticatedError` distinguishes eight causes — `no_cookie`,
 * `bad_signature`, `session_revoked`, `session_expired` and so on — and every one of them
 * becomes the same 401 with the same body. The cause travels to the log on `auditCode`.
 *
 * ## The refusal is now recorded — status defect 4
 *
 * Every one of those causes is a denied sensitive attempt (`04-SECURITY-PRIVACY` §4/§6,
 * `25 §12`), and until now none left a row. The refusal is recorded through
 * {@link AuthenticationEventRecorder} with the single safe reason `missing_session` — the fixed
 * cause travels to the log on `auditCode` as before, so nothing more specific needs to reach the
 * table. The record is best-effort by that seam's contract: it cannot change or delay the 401,
 * so a database outage costs an audit row, never the refusal.
 */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SESSION_SERVICE) private readonly sessions: SessionService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(AUTHENTICATION_EVENT_RECORDER)
    private readonly events: AuthenticationEventRecorder,
    @Inject(PERSONAL_ACCESS_TOKEN_AUTHENTICATOR)
    private readonly personalAccessTokens: PersonalAccessTokensService,
    /** OAuth access tokens for `/mcp` (plan §4.1). Provided by `McpEndpointModule`. */
    @Optional()
    @Inject(MCP_OAUTH_AUTHENTICATOR)
    private readonly mcpOAuth?: McpOAuthTokenAuthenticator,
  ) {}

  /**
   * The process-wide internal-grant store (S6). Not injected: it is in-process memory shared with
   * the MCP endpoint, deliberately with no DI or database seam behind it. A field so a test can
   * substitute a store with a controllable clock.
   */
  private internalGrants: Pick<InternalGrantStore, 'consume'> = internalGrants;

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<{
      readonly ip?: string;
      readonly url?: unknown;
      readonly headers: Record<string, string | string[] | undefined>;
      readonly raw?: unknown;
    }>();
    const state = requireRequestState(request);

    // MCP connector S6 — the one-time internal grant. The hosted MCP endpoint executes each tool
    // call as an in-process inject carrying a nonce in `x-tmanage-internal-grant` and NO
    // `Authorization` header: the AI client's own token is never forwarded (architecture B1). The
    // nonce stands in for the principal the outer request already proved. Two gates before it is
    // trusted (architecture B3): the request must be an in-process inject — a real network request
    // bearing the header is refused here even if the edge did not strip it (`T-B3-01`) — and the
    // nonce must redeem, which it does at most once and within 30 seconds (`T-B3-02`).
    const grantHeader = request.headers[INTERNAL_GRANT_HEADER];
    if (typeof grantHeader === 'string') {
      if (!isInProcessRequest(request.raw)) {
        this.recordRefusal(request, state.correlationId);
        throw new ApiError(
          401,
          'unauthenticated',
          MESSAGES.unauthenticated,
          undefined,
          'internal_grant_from_network',
        );
      }
      const payload = this.internalGrants.consume(grantHeader);
      if (payload === undefined) {
        this.recordRefusal(request, state.correlationId);
        throw new ApiError(
          401,
          'unauthenticated',
          MESSAGES.unauthenticated,
          undefined,
          'internal_grant_invalid',
        );
      }
      // The same bound-token principal a PAT would produce, so every downstream tenant rule
      // (org binding, directory narrowing, the AI-assistant audit channel) applies unchanged —
      // the grant is a different proof of the same member, not a different member. The AI client
      // it acts for is recorded separately on `aiGrant`, for attribution, never for access.
      state.session = { sessionId: `ai:${payload.grantId}`, userId: payload.userId };
      state.authScheme = 'ai_grant';
      state.personalAccessToken = {
        organizationId: payload.organizationId,
        membershipId: payload.membershipId,
      };
      state.aiGrant = {
        grantId: payload.grantId,
        clientId: payload.clientId,
        clientName: payload.clientName,
        opId: payload.opId,
      };
      return true;
    }

    const cookieHeader = request.headers['cookie'];
    const accessToken = readCookie(
      typeof cookieHeader === 'string' ? cookieHeader : undefined,
      this.config.cookieName,
    );

    // No session cookie — a Bearer personal access token may authenticate instead (0202). This
    // runs ONLY when there is no cookie, so a request that carries a cookie always takes the
    // cookie path below and stays subject to CSRF. A token acts as its own member with no
    // elevation; the membership resolver and permission checks run afterwards as for a cookie.
    if (accessToken === undefined) {
      const bearer = readBearerToken(request.headers['authorization']);
      // An OAuth access token (opaque, no PAT prefix) is accepted on `/mcp` only — its audience is
      // that resource, so it is never a key to the REST API directly. It proves the same kind of
      // bound principal a PAT does; its grant, scopes and client go to the endpoint privately.
      if (
        bearer !== undefined &&
        this.mcpOAuth !== undefined &&
        !bearer.startsWith(TOKEN_PREFIX) &&
        isMcpPath(request.url)
      ) {
        try {
          const access = await this.mcpOAuth.authenticate(bearer, state.correlationId);
          state.session = { sessionId: `oauth:${access.grantId}`, userId: access.userId };
          state.authScheme = 'ai_grant';
          state.personalAccessToken = {
            organizationId: access.organizationId,
            membershipId: access.membershipId,
          };
          state.aiGrant = {
            grantId: access.grantId,
            clientId: access.clientId,
            clientName: access.clientName,
            opId: 'POST /mcp',
          };
          recordMcpOAuthAccess(state, access);
          return true;
        } catch (error) {
          if (error instanceof McpOAuthNotAuthenticatedError) {
            this.recordRefusal(request, state.correlationId);
            throw this.unauthenticated(request, error.code);
          }
          throw error;
        }
      }
      if (bearer !== undefined) {
        try {
          const authed = await this.personalAccessTokens.authenticate(bearer, state.correlationId);
          state.session = { sessionId: `pat:${authed.tokenId}`, userId: authed.userId };
          state.authScheme = 'personal_access_token';
          // The token is bound to ONE organization and membership (0202). Carry that binding so
          // `TenantContextGuard` can refuse the token against any other org the member belongs to —
          // a token is not a key to every tenant its member is in. Produced from the token row,
          // never read off the request, which is why it is trusted downstream.
          state.personalAccessToken = {
            organizationId: authed.organizationId,
            membershipId: authed.membershipId,
          };
          return true;
        } catch (error) {
          if (error instanceof PersonalAccessTokenNotAuthenticatedError) {
            this.recordRefusal(request, state.correlationId);
            throw this.unauthenticated(request, error.code);
          }
          throw error;
        }
      }
    }

    try {
      state.session = await this.sessions.authenticate({
        accessToken,
        correlationId: state.correlationId,
      });
      state.authScheme = 'cookie';
    } catch (error) {
      if (error instanceof SessionNotAuthenticatedError) {
        // Record the denied attempt before refusing. Best-effort by the seam's contract — it
        // returns immediately and never throws — so the 401 below is untouched in status, body
        // and timing whether or not the row is written. The `try` is defence in depth: the
        // refusal is the control and no recorder, however it misbehaves, may take its place.
        this.recordRefusal(request, state.correlationId);
        throw this.unauthenticated(request, error.code);
      }
      throw error;
    }

    return true;
  }

  /**
   * The 401. On `/mcp` it carries the OAuth challenge (`WWW-Authenticate: Bearer
   * resource_metadata=…`) so an AI client can discover the authorization server from it; every
   * other route keeps the plain 401 it always had.
   */
  private unauthenticated(request: { readonly url?: unknown }, auditCode: string): ApiError {
    if (isMcpPath(request.url)) return mcpUnauthenticated(this.config, auditCode);
    return new ApiError(401, 'unauthenticated', MESSAGES.unauthenticated, undefined, auditCode);
  }

  /**
   * Record a denied authentication attempt — the same best-effort seam for a bad cookie and a
   * bad Bearer token. It returns immediately and never throws, so the 401 the caller sees is
   * untouched in status, body and timing whether or not the row is written. The precise cause
   * travels to the log on `auditCode`; the table carries only the fixed `missing_session` reason.
   */
  private recordRefusal(
    request: {
      readonly ip?: string;
      readonly headers: Record<string, string | string[] | undefined>;
    },
    correlationId: string,
  ): void {
    try {
      const userAgent = request.headers['user-agent'];
      this.events.recordGuardRefusal({
        action: GUARD_REFUSAL_ACTIONS.session,
        reason: GUARD_REFUSAL_REASONS.missingSession,
        ip: request.ip ?? null,
        userAgent: typeof userAgent === 'string' ? userAgent : null,
        correlationId,
      });
    } catch {
      // A recording failure is never the caller's problem; the 401 stands.
    }
  }
}

/** Parse a `Authorization: Bearer <token>` header, returning the token or undefined. */
function readBearerToken(header: string | string[] | undefined): string | undefined {
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? (match[1] as string).trim() : undefined;
}
