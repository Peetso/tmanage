import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type {
  IdentityQueryRunner,
  TenantContext,
  TenantDatabase,
} from '../../common/database/tenant-context.js';
import { OAUTH_GRANT_BOOTSTRAP_REASON, OAUTH_IDENTITY_TABLES } from './oauth-tokens.repository.js';
import type { OauthTokensRepository } from './oauth-tokens.repository.js';
import type { OauthClientRow } from '../../common/database/schema.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { SessionsRepository } from '../identity/sessions.repository.js';
import { assertCimdUrl, CimdError, type CimdFetcher } from './cimd-fetcher.js';
import { GrantsRepository } from './grants.repository.js';
import { verifyPkceS256 } from './pkce.js';
import { matchesRegisteredRedirect } from './redirect-uri.js';
import { parseScopes, scopesToString } from './scopes.js';
import type { AiAccessSwitches } from './ai-access.js';

/**
 * The OAuth 2.1 authorization server logic (MCP connector S7).
 *
 * This is the whole protocol core in one place so the invariants that must hold together do:
 * PKCE S256 only, exact/loopback redirect match, codes single-use and bound to client + redirect
 * + resource + challenge, access tokens audience-bound and opaque, refresh tokens rotated on use
 * with family-wide reuse detection. The controllers are thin HTTP shells over these methods.
 *
 * Secrets never leave as plaintext except the one time a value is minted and handed back: codes,
 * access tokens and refresh tokens are stored only as their SHA-256 hex.
 */

/** 30-minute access tokens — Claude refreshes them early (architecture §"Design decisions"). */
export const ACCESS_TOKEN_TTL_SECONDS = 30 * 60;
/** 60-second authorization codes (threat model B1: codes are single use and short-lived). */
export const CODE_TTL_SECONDS = 60;
/** Refresh tokens: 30 days idle, 90 days absolute. */
export const REFRESH_IDLE_TTL_SECONDS = 30 * 24 * 60 * 60;
export const REFRESH_ABSOLUTE_TTL_SECONDS = 90 * 24 * 60 * 60;

export interface OAuthServiceOptions {
  readonly database: TenantDatabase;
  readonly repository: OauthTokensRepository;
  /** The AS issuer — the API's public origin, e.g. `https://tmanage.peetrix.com`. */
  readonly issuer: string;
  /** The canonical resource/audience — `<issuer>/mcp`. Every request must name exactly this. */
  readonly canonicalResource: string;
  /**
   * The SSRF-guarded CIMD fetcher (S8). Optional so the protocol-core tests can construct the
   * service without it; when absent, an https `client_id` that is not already cached is refused.
   */
  readonly cimdFetcher?: CimdFetcher;
  /**
   * The AI kill switches (S11). When present, a workspace whose owner turned AI off gets no new
   * tokens (403 `access_denied`); the code or refresh token is not spent, so the connection works
   * again once the switch is back on. Optional so the protocol-core tests need no database.
   */
  readonly aiAccess?: AiAccessSwitches;
  /** N04: the consenting session is re-read after the grant commits. Defaults to the real one. */
  readonly sessions?: Pick<SessionsRepository, 'findById'>;
  /** N04: revokes a grant minted for a session that ended meanwhile. Defaults to the real one. */
  readonly grants?: Pick<GrantsRepository, 'revokeGrant'>;
}

/** The identity tables the N04 consent re-check reads. */
const SESSION_TABLES = ['sessions'] as const;

/**
 * The form a client_id is stored and looked up under (NV07 follow-up). A CIMD id is the
 * normalised URL the fetcher inserts (`https://Claude.AI/x` and `https://claude.ai/x` are one
 * client); an opaque DCR id, or a URL the fetcher would refuse anyway, is kept exactly as sent.
 */
export function normaliseClientId(clientId: string): string {
  if (!/^https:\/\//i.test(clientId)) return clientId;
  try {
    return assertCimdUrl(clientId).toString();
  } catch {
    return clientId;
  }
}

/** DCR rate limit — threat model B1: 10 registrations per IP per hour, 1000 per day overall. */
export const DCR_MAX_PER_IP_PER_HOUR = 10;
export const DCR_MAX_PER_DAY = 1000;
/** A CIMD document is re-fetched once its cached row is older than this (threat model B5). */
export const CIMD_CACHE_TTL_SECONDS = 24 * 60 * 60;

/** A registered DCR client, as `/oauth/register` returns it (RFC 7591 §3.2.1). */
export interface RegisteredClient {
  readonly clientPk: string;
  readonly clientId: string;
  readonly name: string;
  readonly redirectUris: readonly string[];
}

/** Thrown when a DCR registration exceeds the per-IP or overall rate limit (T-DCR-02 → HTTP 429). */
export class DcrRateLimitError extends Error {
  override name = 'DcrRateLimitError';
}

export interface TokenResponse {
  readonly access_token: string;
  readonly token_type: 'Bearer';
  readonly expires_in: number;
  readonly refresh_token: string;
  readonly scope: string;
}

/** An OAuth error with the RFC 6749 `error` code and whether it may be sent to the redirect. */
export class OAuthError extends Error {
  constructor(
    readonly code: string,
    readonly description: string,
    /** false → the request is too broken to trust the redirect (bad client/redirect/PKCE). */
    readonly redirectable: boolean,
    readonly httpStatus = 400,
  ) {
    super(description);
    this.name = 'OAuthError';
  }
}

/** MySQL/MariaDB duplicate-key error, seen directly or one level down on Drizzle's `.cause`. */
function isDuplicateKeyError(error: unknown): boolean {
  const marks = (candidate: unknown): boolean =>
    typeof candidate === 'object' &&
    candidate !== null &&
    ((candidate as { errno?: number }).errno === 1062 ||
      (candidate as { code?: string }).code === 'ER_DUP_ENTRY');
  if (marks(error)) return true;
  return typeof error === 'object' && error !== null && marks((error as { cause?: unknown }).cause);
}

function hashToken(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** A 256-bit opaque token, base64url (no padding) — unguessable and URL-safe. */
function newOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface AuthorizeParams {
  readonly responseType: unknown;
  readonly clientId: unknown;
  readonly redirectUri: unknown;
  readonly codeChallenge: unknown;
  readonly codeChallengeMethod: unknown;
  readonly resource: unknown;
  readonly scope?: unknown;
  readonly state?: unknown;
}

export interface ValidatedAuthorize {
  readonly clientPk: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly verified: boolean;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly scopes: readonly string[];
  readonly resource: string;
  readonly state: string | null;
}

export class OAuthService {
  private readonly database: TenantDatabase;
  private readonly repo: OauthTokensRepository;
  private readonly issuer: string;
  private readonly canonicalResource: string;
  private readonly cimdFetcher: CimdFetcher | undefined;
  private readonly aiAccess: AiAccessSwitches | undefined;
  private readonly sessions: Pick<SessionsRepository, 'findById'>;
  private readonly grants: Pick<GrantsRepository, 'revokeGrant'>;

  constructor(options: OAuthServiceOptions) {
    this.database = options.database;
    this.repo = options.repository;
    this.issuer = options.issuer;
    this.canonicalResource = options.canonicalResource;
    this.cimdFetcher = options.cimdFetcher;
    this.aiAccess = options.aiAccess;
    this.sessions = options.sessions ?? new SessionsRepository();
    this.grants = options.grants ?? new GrantsRepository();
  }

  get issuerUrl(): string {
    return this.issuer;
  }

  get resourceUri(): string {
    return this.canonicalResource;
  }

  /**
   * Validate an `/oauth/authorize` request. The order is deliberate: the client and the redirect
   * are checked first and, if either is wrong, the error is **not** redirectable — the browser is
   * never bounced to an unverified location (threat model B1). Only once the redirect is trusted
   * do the remaining failures (PKCE, resource, scope) become things a client is told about.
   *
   * PKCE is the one exception that stays non-redirectable even with a good redirect: a missing or
   * non-S256 challenge means code interception is possible, so the flow is stopped dead (T-OA-02).
   */
  async validateAuthorize(
    params: AuthorizeParams,
    correlationId: string,
    /** The requester's address, charged against the CIMD per-source fetch budget (N06). */
    requester?: string | null,
  ): Promise<ValidatedAuthorize> {
    const clientId = typeof params.clientId === 'string' ? params.clientId : '';
    const redirectUri = typeof params.redirectUri === 'string' ? params.redirectUri : '';
    if (clientId === '') {
      throw new OAuthError('invalid_request', 'Missing client_id.', false);
    }

    // A `client_id` that is an https URL is a CIMD client — resolved (fetched once, cached 24 h)
    // through the SSRF-guarded fetcher. Any other value is an opaque DCR id, looked up directly.
    const client = /^https:\/\//i.test(clientId)
      ? await this.resolveCimdClient(clientId, correlationId, requester)
      : await this.database.identityRead(
          { correlationId, tables: [...OAUTH_IDENTITY_TABLES] },
          (db) => this.repo.findClientByClientId(db, clientId),
        );
    if (!client) {
      throw new OAuthError('invalid_client', 'Unknown client_id.', false);
    }
    if (redirectUri === '' || !matchesRegisteredRedirect(redirectUri, client.redirectUrisJson)) {
      throw new OAuthError(
        'invalid_request',
        'redirect_uri does not match a registered URI.',
        false,
      );
    }

    // The redirect is trusted from here on, but PKCE downgrade is still fatal (T-OA-02).
    if (params.codeChallengeMethod !== 'S256') {
      throw new OAuthError('invalid_request', 'code_challenge_method must be S256.', false);
    }
    if (typeof params.codeChallenge !== 'string' || params.codeChallenge === '') {
      throw new OAuthError('invalid_request', 'Missing code_challenge.', false);
    }

    const state = typeof params.state === 'string' ? params.state : null;
    if (params.responseType !== 'code') {
      throw new OAuthError('unsupported_response_type', 'response_type must be code.', true);
    }
    if (typeof params.resource !== 'string' || params.resource !== this.canonicalResource) {
      throw new OAuthError(
        'invalid_target',
        `resource must equal ${this.canonicalResource}.`,
        true,
      );
    }
    const scopes = parseScopes(params.scope);

    return {
      clientPk: client.id,
      clientId: client.clientId,
      clientName: client.name,
      verified: client.verified,
      redirectUri,
      challenge: params.codeChallenge,
      scopes,
      resource: params.resource,
      state,
    };
  }

  /**
   * Register a public client via Dynamic Client Registration (RFC 7591; MCP connector S8). The
   * metadata is already validated and sanitised by the caller (`dcr-metadata.ts`); this method
   * owns the rate limit and the write. The two counts and the insert run in one identity
   * transaction so a burst of concurrent registrations cannot each read "9 so far" and all slip
   * past the per-IP cap. An opaque, unguessable `client_id` is minted — never a secret, since
   * these are public clients. Throws `DcrRateLimitError` when either limit is reached.
   */
  async registerClient(
    input: {
      readonly name: string;
      readonly redirectUris: readonly string[];
      /** SHA-256 of the registering IP, for the per-IP limit and abuse review. */
      readonly ipHash: string;
    },
    correlationId: string,
  ): Promise<RegisteredClient> {
    const clientPk = randomUUID();
    const clientId = randomBytes(24).toString('base64url');
    await this.database.identityTransaction(
      { correlationId, tables: [...OAUTH_IDENTITY_TABLES] },
      async (tx) => {
        const perIp = await this.repo.countClientsByIpHashSince(tx, input.ipHash, 60 * 60);
        if (perIp >= DCR_MAX_PER_IP_PER_HOUR) {
          throw new DcrRateLimitError('Too many client registrations from this address this hour.');
        }
        const perDay = await this.repo.countDcrClientsSince(tx, 24 * 60 * 60);
        if (perDay >= DCR_MAX_PER_DAY) {
          throw new DcrRateLimitError('Too many client registrations today; try again later.');
        }
        await this.repo.insertClient(tx, {
          id: clientPk,
          clientId,
          kind: 'dcr',
          name: input.name,
          redirectUris: input.redirectUris,
          verified: false,
          createdIpHash: input.ipHash,
        });
      },
    );
    return { clientPk, clientId, name: input.name, redirectUris: input.redirectUris };
  }

  /**
   * Resolve a CIMD client by its metadata-document URL. A cached row younger than 24 h is used as
   * is; otherwise the document is re-fetched through the SSRF-guarded fetcher and the row is
   * upserted. If the fetch fails but a (stale) row exists, that row is used — a vendor's blip does
   * not lock out a client already known. A first-time fetch failure, or an unconfigured fetcher,
   * yields `null`, which the authorize path turns into a non-redirectable `invalid_client`.
   *
   * N06: when the fetcher is over a cap (`429`) a stale row is served the same way, so filling
   * the caps cannot lock out a client TManage already knows; only a first-time client sees 429.
   * NV07 follow-up: the row is looked up under the normalised id (the value the fetcher returns
   * and the insert writes), so a differently-cased URL no longer misses it and hits a duplicate key.
   */
  async resolveCimdClient(
    clientIdUrl: string,
    correlationId: string,
    requester?: string | null,
  ): Promise<OauthClientRow | null> {
    const lookupId = normaliseClientId(clientIdUrl);
    const existing = await this.database.identityRead(
      { correlationId, tables: [...OAUTH_IDENTITY_TABLES] },
      (db) => this.repo.findClientByClientId(db, lookupId),
    );
    if (existing && existing.kind === 'cimd' && this.isCimdFresh(existing)) return existing;
    if (!this.cimdFetcher) return existing ?? null;

    let fetched;
    try {
      fetched = await this.cimdFetcher.fetchMetadata(clientIdUrl, requester);
    } catch (error) {
      if (error instanceof ApiError && error.status === 429 && existing) return existing;
      if (!(error instanceof CimdError)) throw error;
      // Fall back to a known (if stale) row; otherwise the client is unknown.
      return existing ?? null;
    }

    // Two first-time requests for one client share one fetch and may race to insert the row; the
    // loser's duplicate key means the row now exists, so it is simply read back (NV07 follow-up).
    await this.database
      .identityTransaction({ correlationId, tables: [...OAUTH_IDENTITY_TABLES] }, async (tx) => {
        if (existing) {
          await this.repo.refreshCimdClient(tx, {
            id: existing.id,
            name: fetched.name,
            redirectUris: fetched.redirectUris,
            verified: fetched.verified,
          });
        } else {
          await this.repo.insertClient(tx, {
            id: randomUUID(),
            clientId: fetched.clientId,
            kind: 'cimd',
            name: fetched.name,
            redirectUris: fetched.redirectUris,
            verified: fetched.verified,
            createdIpHash: null,
          });
        }
      })
      .catch((error: unknown) => {
        if (!isDuplicateKeyError(error)) throw error;
      });
    return this.database.identityRead({ correlationId, tables: [...OAUTH_IDENTITY_TABLES] }, (db) =>
      this.repo.findClientByClientId(db, fetched.clientId),
    );
  }

  /**
   * N04: re-read the consenting session after the grant committed. If it ended meanwhile (or is
   * not this person's), revoke the grant and anything it issued, spend its code, and refuse 401.
   */
  private async assertConsentSessionLive(
    context: TenantContext,
    sessionId: string,
    grantId: string,
    codeHash: string,
  ): Promise<void> {
    const state = await this.database.identityRead(
      { correlationId: context.correlationId, tables: [...SESSION_TABLES] },
      (db) => this.sessions.findById(db, sessionId),
    );
    const live =
      state !== null &&
      state.session.revokedAt === null &&
      !state.expired &&
      state.session.userId === context.userId;
    if (live) return;
    await this.database.transaction(context, async (tx) => {
      await this.grants.revokeGrant(tx, context, grantId, null);
      await this.repo.revokeTokensByGrant(tx, grantId);
      await this.repo.spendCode(tx, codeHash);
    });
    throw new ApiError(
      401,
      'unauthenticated',
      MESSAGES.unauthenticated,
      undefined,
      'consent_session_ended',
    );
  }

  /** A cached CIMD row is fresh while it (its last fetch or creation) is younger than 24 h. */
  private isCimdFresh(client: OauthClientRow): boolean {
    const stamp = client.lastUsedAt ?? client.createdAt;
    if (!(stamp instanceof Date)) return false;
    return Date.now() - stamp.getTime() < CIMD_CACHE_TTL_SECONDS * 1000;
  }

  /**
   * Record a consent decision: create the grant (under the signed-in user's chosen organization)
   * and a one-time code bound to the client's redirect, the PKCE challenge and the resource. Both
   * writes land in one tenant transaction. Returns the final redirect back to the client, carrying
   * the code, the echoed `state`, and `iss` (threat model B1, mix-up defence).
   *
   * The caller (S9 consent page handler) supplies the `TenantContext` for the chosen organization
   * after verifying the user's membership; S7 owns the minting, not the UI.
   *
   * N04: a recovery (password reset, sign-out everywhere) revokes the person's sessions and their
   * live grants. A consent already past the session guard when that cutoff ran would mint a grant
   * after it and survive. So once the grant commits, the consenting session is read again; if it
   * is gone, revoked or expired, the grant, its tokens and its code are revoked and the request is
   * refused with 401. Whichever of the two finishes last, no grant outlives the cutoff.
   */
  async grantConsent(
    context: TenantContext,
    input: {
      readonly clientPk: string;
      readonly membershipId: string;
      readonly userId: string;
      readonly redirectUri: string;
      readonly challenge: string;
      readonly resource: string;
      readonly scopes: readonly string[];
      readonly state: string | null;
      /**
       * The consenting cookie session (N04). The consent controller always passes it; it is
       * optional only so the protocol-core tests can mint a grant without a session store.
       */
      readonly sessionId?: string;
    },
    ids: { grantId: string },
  ): Promise<{ redirectUrl: string; code: string }> {
    const code = newOpaqueToken();
    await this.database.transaction(context, async (tx) => {
      await this.repo.insertGrant(tx, {
        id: ids.grantId,
        organizationId: context.organizationId,
        clientPk: input.clientPk,
        membershipId: input.membershipId,
        userId: input.userId,
        scopes: scopesToString(input.scopes),
      });
      await this.repo.insertCode(tx, {
        codeHash: hashToken(code),
        grantId: ids.grantId,
        challenge: input.challenge,
        redirectUri: input.redirectUri,
        resource: input.resource,
        ttlSeconds: CODE_TTL_SECONDS,
      });
    });
    if (input.sessionId !== undefined) {
      await this.assertConsentSessionLive(context, input.sessionId, ids.grantId, hashToken(code));
    }
    return {
      code,
      redirectUrl: this.buildRedirect(input.redirectUri, { code, state: input.state }),
    };
  }

  /**
   * Exchange an authorization code for tokens. Verifies the code's bindings (redirect, resource,
   * and the owning client), the PKCE verifier against the stored S256 challenge, spends the code
   * atomically, and mints an access token and a refresh token in a new family. A replayed code
   * (already spent) revokes every token the grant issued and returns `invalid_grant` (T-OA-05).
   */
  async exchangeCode(
    input: {
      readonly code: unknown;
      readonly codeVerifier: unknown;
      readonly redirectUri: unknown;
      readonly clientId: unknown;
      readonly resource: unknown;
    },
    correlationId: string,
  ): Promise<TokenResponse> {
    const code = typeof input.code === 'string' ? input.code : '';
    const verifier = typeof input.codeVerifier === 'string' ? input.codeVerifier : '';
    const clientId = typeof input.clientId === 'string' ? input.clientId : '';
    if (code === '' || verifier === '' || clientId === '') {
      throw new OAuthError('invalid_request', 'Missing code, code_verifier or client_id.', false);
    }

    const codeHash = hashToken(code);
    const codeRow = await this.database.identityRead(
      { correlationId, tables: [...OAUTH_IDENTITY_TABLES] },
      (db) => this.repo.findCodeByHash(db, codeHash),
    );
    if (!codeRow) {
      throw new OAuthError('invalid_grant', 'Unknown or expired authorization code.', false);
    }

    const grant = await this.database.bootstrapRead(
      { correlationId, reason: OAUTH_GRANT_BOOTSTRAP_REASON, tables: ['oauth_grants'] },
      (db) => this.repo.findGrantById(db, codeRow.grantId),
    );
    if (!grant) {
      throw new OAuthError('invalid_grant', 'The grant no longer exists.', false);
    }

    // A replayed code: revoke everything it issued, then refuse (threat model B1, T-OA-05).
    if (codeRow.usedAt !== null) {
      await this.database.identityTransaction(
        { correlationId, tables: [...OAUTH_IDENTITY_TABLES] },
        (tx) => this.repo.revokeTokensByGrant(tx, grant.id),
      );
      throw new OAuthError('invalid_grant', 'Authorization code already used.', false);
    }

    const client = await this.database.identityRead(
      { correlationId, tables: [...OAUTH_IDENTITY_TABLES] },
      (db) => this.repo.findClientByClientId(db, normaliseClientId(clientId)),
    );
    if (!client || client.id !== grant.clientPk) {
      throw new OAuthError('invalid_grant', 'client_id does not match the code.', false);
    }
    if (input.redirectUri !== codeRow.redirectUri) {
      throw new OAuthError('invalid_grant', 'redirect_uri does not match the code.', false);
    }
    if (input.resource !== codeRow.resource || codeRow.resource !== this.canonicalResource) {
      throw new OAuthError('invalid_target', 'resource does not match the code.', false);
    }
    if (grant.revokedAt !== null) {
      throw new OAuthError('invalid_grant', 'The grant has been revoked.', false);
    }
    if (!verifyPkceS256(verifier, codeRow.challenge)) {
      throw new OAuthError('invalid_grant', 'PKCE verification failed.', false);
    }
    await this.assertWorkspaceAllowsAi(grant.organizationId, correlationId);

    const familyId = randomBytes(16).toString('hex');
    return this.mintTokens(correlationId, {
      grantId: grant.id,
      familyId,
      scopes: grant.scopes,
      parentHash: null,
      absoluteExpiresAt: null,
      spend: async (tx) => {
        const spent = await this.repo.spendCode(tx, codeHash);
        if (!spent)
          throw new OAuthError('invalid_grant', 'Authorization code already used.', false);
      },
    });
  }

  /**
   * Rotate a refresh token. Reuse detection (threat model B1, T-OA-06): presenting an
   * already-used refresh token revokes the whole family and returns `invalid_grant`. Otherwise the
   * presented token is spent and a fresh access + refresh pair is issued in the same family, with
   * the absolute expiry carried forward unchanged. OAuth 2.1 §4.3.1: the token is bound to the public
   * client it was issued to, so `client_id` is required and a token issued to another client is
   * refused (`invalid_grant`) without being spent.
   */
  async refresh(
    input: {
      readonly refreshToken: unknown;
      readonly resource: unknown;
      readonly clientId?: unknown;
    },
    correlationId: string,
  ): Promise<TokenResponse> {
    const refreshToken = typeof input.refreshToken === 'string' ? input.refreshToken : '';
    if (refreshToken === '') {
      throw new OAuthError('invalid_request', 'Missing refresh_token.', false);
    }
    if (input.resource !== undefined && input.resource !== this.canonicalResource) {
      throw new OAuthError('invalid_target', 'resource does not match.', false);
    }

    const tokenHash = hashToken(refreshToken);
    const row = await this.database.identityRead(
      { correlationId, tables: [...OAUTH_IDENTITY_TABLES] },
      (db) => this.repo.findRefreshTokenByHash(db, tokenHash),
    );
    if (!row) {
      throw new OAuthError('invalid_grant', 'Unknown refresh token.', false);
    }
    // Reuse: an already-used (or already-revoked) token means the family is compromised.
    if (row.usedAt !== null || row.revokedAt !== null) {
      await this.database.identityTransaction(
        { correlationId, tables: [...OAUTH_IDENTITY_TABLES] },
        (tx) => this.repo.revokeFamily(tx, row.familyId),
      );
      throw new OAuthError('invalid_grant', 'Refresh token reuse detected.', false);
    }

    const grant = await this.database.bootstrapRead(
      { correlationId, reason: OAUTH_GRANT_BOOTSTRAP_REASON, tables: ['oauth_grants'] },
      (db) => this.repo.findGrantById(db, row.grantId),
    );
    if (!grant || grant.revokedAt !== null) {
      await this.database.identityTransaction(
        { correlationId, tables: [...OAUTH_IDENTITY_TABLES] },
        (tx) => this.repo.revokeFamily(tx, row.familyId),
      );
      throw new OAuthError('invalid_grant', 'The grant has been revoked.', false);
    }
    await this.assertWorkspaceAllowsAi(grant.organizationId, correlationId);

    // Bind the refresh token to the public client it was issued to (OAuth 2.1 §4.3.1). Checked
    // before the spend, so a foreign client cannot burn — or rotate — another client's token.
    const clientId = typeof input.clientId === 'string' ? input.clientId : '';
    if (clientId === '') {
      throw new OAuthError('invalid_request', 'Missing client_id.', false);
    }
    const client = await this.database.identityRead(
      { correlationId, tables: [...OAUTH_IDENTITY_TABLES] },
      (db) => this.repo.findClientByClientId(db, normaliseClientId(clientId)),
    );
    if (!client || client.id !== grant.clientPk) {
      throw new OAuthError('invalid_grant', 'client_id does not match the refresh token.', false);
    }

    let lostRace = false;
    try {
      return await this.mintTokens(correlationId, {
        grantId: grant.id,
        familyId: row.familyId,
        scopes: grant.scopes,
        parentHash: tokenHash,
        absoluteExpiresAt: row.absoluteExpiresAt,
        spend: async (tx) => {
          const spent = await this.repo.spendRefreshToken(tx, tokenHash);
          if (!spent) {
            lostRace = true;
            throw new OAuthError('invalid_grant', 'Refresh token reuse detected.', false);
          }
        },
      });
    } catch (error) {
      // Lost the race to another use of the same token — treat as reuse. The revocation runs in
      // its own transaction: inside the failed one, the rollback would undo it and leave the
      // racing winner's fresh tokens live.
      if (lostRace) {
        await this.database.identityTransaction(
          { correlationId, tables: [...OAUTH_IDENTITY_TABLES] },
          (tx) => this.repo.revokeFamily(tx, row.familyId),
        );
      }
      throw error;
    }
  }

  /**
   * Revoke the family a presented token belongs to (RFC 7009). Works for an access token or a
   * refresh token; an unknown token is a silent success, as RFC 7009 §2.2 requires.
   */
  /** S11: no tokens for a workspace whose owner turned AI apps off. Nothing is spent first. */
  private async assertWorkspaceAllowsAi(organizationId: string, correlationId: string) {
    if (this.aiAccess && !(await this.aiAccess.organizationOn(organizationId, correlationId))) {
      throw new OAuthError(
        'access_denied',
        'AI apps are turned off for this workspace.',
        false,
        403,
      );
    }
  }

  async revoke(token: unknown, correlationId: string): Promise<void> {
    if (typeof token !== 'string' || token === '') return;
    const tokenHash = hashToken(token);
    await this.database.identityTransaction(
      { correlationId, tables: [...OAUTH_IDENTITY_TABLES] },
      async (tx) => {
        const refresh = await this.repo.findRefreshTokenByHash(tx, tokenHash);
        if (refresh) {
          await this.repo.revokeFamily(tx, refresh.familyId);
          return;
        }
        const access = await this.repo.findAnyAccessTokenByHash(tx, tokenHash);
        if (access) await this.repo.revokeFamily(tx, access.familyId);
      },
    );
  }

  /** Mint an access + refresh pair in one transaction, running `spend` first so the swap is atomic. */
  private async mintTokens(
    correlationId: string,
    input: {
      readonly grantId: string;
      readonly familyId: string;
      readonly scopes: string;
      readonly parentHash: string | null;
      readonly absoluteExpiresAt: Date | null;
      readonly spend: (tx: IdentityQueryRunner) => Promise<void>;
    },
  ): Promise<TokenResponse> {
    const accessToken = newOpaqueToken();
    const refreshToken = newOpaqueToken();
    await this.database.identityTransaction(
      { correlationId, tables: [...OAUTH_IDENTITY_TABLES] },
      async (tx) => {
        await input.spend(tx);
        await this.repo.insertAccessToken(tx, {
          tokenHash: hashToken(accessToken),
          grantId: input.grantId,
          familyId: input.familyId,
          audience: this.canonicalResource,
          scopes: input.scopes,
          ttlSeconds: ACCESS_TOKEN_TTL_SECONDS,
        });
        await this.repo.insertRefreshToken(tx, {
          tokenHash: hashToken(refreshToken),
          familyId: input.familyId,
          grantId: input.grantId,
          parentHash: input.parentHash,
          idleTtlSeconds: REFRESH_IDLE_TTL_SECONDS,
          absoluteExpiresAt: input.absoluteExpiresAt,
          absoluteTtlSeconds: REFRESH_ABSOLUTE_TTL_SECONDS,
        });
      },
    );
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: input.scopes,
    };
  }

  /** Build a redirect back to the client, always carrying `iss` (mix-up defence, T-OA-08). */
  buildRedirect(
    redirectUri: string,
    params: { code?: string; state: string | null; error?: string; errorDescription?: string },
  ): string {
    const url = new URL(redirectUri);
    if (params.code !== undefined) url.searchParams.set('code', params.code);
    if (params.error !== undefined) url.searchParams.set('error', params.error);
    if (params.errorDescription !== undefined) {
      url.searchParams.set('error_description', params.errorDescription);
    }
    if (params.state !== null) url.searchParams.set('state', params.state);
    url.searchParams.set('iss', this.issuer);
    return url.toString();
  }
}
