import { createHash, randomBytes } from 'node:crypto';
import type {
  IdentityQueryRunner,
  TenantContext,
  TenantDatabase,
} from '../../common/database/tenant-context.js';
import { OAUTH_GRANT_BOOTSTRAP_REASON, OAUTH_IDENTITY_TABLES } from './oauth-tokens.repository.js';
import type { OauthTokensRepository } from './oauth-tokens.repository.js';
import { verifyPkceS256 } from './pkce.js';
import { matchesRegisteredRedirect } from './redirect-uri.js';
import { parseScopes, scopesToString } from './scopes.js';

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

  constructor(options: OAuthServiceOptions) {
    this.database = options.database;
    this.repo = options.repository;
    this.issuer = options.issuer;
    this.canonicalResource = options.canonicalResource;
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
  ): Promise<ValidatedAuthorize> {
    const clientId = typeof params.clientId === 'string' ? params.clientId : '';
    const redirectUri = typeof params.redirectUri === 'string' ? params.redirectUri : '';
    if (clientId === '') {
      throw new OAuthError('invalid_request', 'Missing client_id.', false);
    }

    const client = await this.database.identityRead(
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
   * Record a consent decision: create the grant (under the signed-in user's chosen organization)
   * and a one-time code bound to the client's redirect, the PKCE challenge and the resource. Both
   * writes land in one tenant transaction. Returns the final redirect back to the client, carrying
   * the code, the echoed `state`, and `iss` (threat model B1, mix-up defence).
   *
   * The caller (S9 consent page handler) supplies the `TenantContext` for the chosen organization
   * after verifying the user's membership; S7 owns the minting, not the UI.
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
      (db) => this.repo.findClientByClientId(db, clientId),
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
   * the absolute expiry carried forward unchanged.
   */
  async refresh(
    input: { readonly refreshToken: unknown; readonly resource: unknown },
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

    return this.mintTokens(correlationId, {
      grantId: grant.id,
      familyId: row.familyId,
      scopes: grant.scopes,
      parentHash: tokenHash,
      absoluteExpiresAt: row.absoluteExpiresAt,
      spend: async (tx) => {
        const spent = await this.repo.spendRefreshToken(tx, tokenHash);
        if (!spent) {
          // Lost the race to another use of the same token — treat as reuse.
          await this.repo.revokeFamily(tx, row.familyId);
          throw new OAuthError('invalid_grant', 'Refresh token reuse detected.', false);
        }
      },
    });
  }

  /**
   * Revoke the family a presented token belongs to (RFC 7009). Works for an access token or a
   * refresh token; an unknown token is a silent success, as RFC 7009 §2.2 requires.
   */
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
