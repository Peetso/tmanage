import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { createServiceContext } from '../../common/database/tenant-context.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { PersonalAccessTokenRow } from '../../common/database/schema.js';
import {
  evaluateTokenUsability,
  hashPersonalAccessToken,
  isWellFormedPersonalAccessToken,
  mintPersonalAccessToken,
} from './personal-access-token.js';
import { SessionsRepository } from '../identity/sessions.repository.js';
import { PersonalAccessTokensRepository } from './personal-access-tokens.repository.js';
import type { PersonalAccessTokenAuthRow } from './personal-access-tokens.repository.js';

/**
 * The application service for personal access tokens.
 *
 * It wears two hats. For the Security screen it manages a member's own tokens under a
 * `TenantContext` — list, create (the one time the plaintext is returned), revoke. For the
 * Bearer authentication path it resolves a presented token to the member it authenticates,
 * before any `TenantContext` exists.
 *
 * A token never grants more than its member has: {@link authenticate} returns only the member's
 * identity, and the ordinary membership-resolver and permission checks run afterwards exactly as
 * they do for a cookie session.
 */

/** What a caller may see of one token. The hash is never projected; only the display hint is. */
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
  /** The plaintext token. Shown to the creator once and never retrievable again. */
  readonly token: string;
}

/** The identity a successfully authenticated token resolves to. */
export interface AuthenticatedToken {
  readonly tokenId: string;
  readonly organizationId: string;
  readonly membershipId: string;
  readonly userId: string;
}

export type PersonalAccessTokenRejection = 'malformed' | 'unknown' | 'revoked' | 'expired';

export class PersonalAccessTokenNotAuthenticatedError extends Error {
  constructor(readonly code: PersonalAccessTokenRejection) {
    super('The personal access token was not accepted');
    this.name = 'PersonalAccessTokenNotAuthenticatedError';
  }
}

const MAX_NAME_LENGTH = 190;
const MAX_EXPIRY_DAYS = 365;

/** N04: the creating session ended while the token was being minted; the token is revoked. */
function sessionRevoked(): ApiError {
  return new ApiError(
    401,
    'unauthenticated',
    MESSAGES.unauthenticated,
    undefined,
    'session_revoked',
  );
}

function toView(row: PersonalAccessTokenRow): PersonalAccessTokenView {
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export class PersonalAccessTokensService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly tokens: PersonalAccessTokensRepository = new PersonalAccessTokensRepository(),
    /** N04 (wave 10): read-only, to re-check the creating session after the insert commits. */
    private readonly sessions: SessionsRepository = new SessionsRepository(),
  ) {}

  /** List the acting member's own tokens, newest first. No hash, no plaintext. */
  async list(
    context: TenantContext,
    principal: Principal,
  ): Promise<readonly PersonalAccessTokenView[]> {
    const rows = await this.database.read(context, (runner) =>
      this.tokens.listForMembership(runner, context, principal.membershipId),
    );
    return rows.map(toView);
  }

  /**
   * Create a token for the acting member. The plaintext is minted here, returned once, and never
   * stored — only its hash and a display hint reach the database. `expiresInDays`, when given, is
   * clamped to a sane ceiling; omitted, the token does not expire.
   *
   * ## The creating session is checked again after the insert — N04 (security audit run 2)
   *
   * A password reset ends sessions in its identity transaction and personal access tokens in a
   * cutoff pass before and after it (`identity/bearer-credentials.ts`). A create whose session
   * passed the guard *before* the reset, but whose insert commits *after* the reset's second
   * cutoff pass, used to leave a live token behind the recovery. So once the insert has
   * committed, the session `sessionId` names is read again: missing, revoked or expired, the new
   * row is revoked in its own tenant transaction and the create answers 401 `session_revoked`.
   * Either the reset's second pass sees the token (it committed first), or this read sees the
   * revoked session (the reset committed first) — there is no order in which both miss.
   * `sessionId` is required: a create with no interactive session behind it is refused.
   */
  async create(
    context: TenantContext,
    principal: Principal,
    input: { name: string; expiresInDays?: number | null; sessionId?: string | undefined },
  ): Promise<CreatedPersonalAccessTokenView> {
    const sessionId = input.sessionId;
    if (typeof sessionId !== 'string' || sessionId === '') throw sessionRevoked();
    const name = input.name.trim();
    if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'name', message: `must be 1 to ${MAX_NAME_LENGTH} characters` },
      ]);
    }
    const expiresAt = this.resolveExpiry(input.expiresInDays ?? null);

    const minted = mintPersonalAccessToken();
    const row = await this.database.transaction(context, (tx) =>
      this.tokens.insert(tx, context, {
        membershipId: principal.membershipId,
        userId: context.userId,
        name,
        tokenHash: minted.tokenHash,
        tokenPrefix: minted.displayPrefix,
        expiresAt,
      }),
    );

    if (!(await this.sessionStillLive(context, sessionId))) {
      await this.database.transaction(context, (tx) =>
        this.tokens.revoke(tx, context, principal.membershipId, row.id, new Date()),
      );
      throw sessionRevoked();
    }
    return { ...toView(row), token: minted.token };
  }

  /** N04: whether the creating session is still present, unrevoked, unexpired and the actor's. */
  private async sessionStillLive(context: TenantContext, sessionId: string): Promise<boolean> {
    const state = await this.database.identityRead(
      { correlationId: context.correlationId, tables: ['sessions'] },
      (db) => this.sessions.findById(db, sessionId),
    );
    return (
      state !== null &&
      !state.expired &&
      state.session.revokedAt === null &&
      state.session.userId === context.userId
    );
  }

  /** Revoke one of the acting member's own tokens. Unknown, foreign, or already-revoked is a 404. */
  async revoke(context: TenantContext, principal: Principal, tokenId: string): Promise<void> {
    const changed = await this.database.transaction(context, (tx) =>
      this.tokens.revoke(tx, context, principal.membershipId, tokenId, new Date()),
    );
    if (changed === 0) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'token_not_visible');
    }
  }

  /**
   * Resolve a presented Bearer token to the member it authenticates — spec §3 step 1 for the
   * token path, before any organization is named.
   *
   * A malformed string is refused without a query. Otherwise the hash is looked up tenant-free on
   * the unique index (the audited bootstrap escape, read-only, one table), and the revocation/expiry
   * rule decides. Every refusal is one error with a distinguishing `code` for the log, the same
   * single-message discipline session authentication keeps. On success the token's last use is
   * recorded best-effort, scoped to its own tenant, and a failure there never costs the request.
   */
  async authenticate(token: string, correlationId: string): Promise<AuthenticatedToken> {
    if (!isWellFormedPersonalAccessToken(token)) {
      throw new PersonalAccessTokenNotAuthenticatedError('malformed');
    }
    const tokenHash = hashPersonalAccessToken(token);
    const row = await this.database.bootstrapRead<PersonalAccessTokenAuthRow | undefined>(
      {
        correlationId,
        reason: 'resolving which member a personal access token authenticates',
        tables: ['personal_access_tokens'],
      },
      (runner) => this.tokens.findUsableByHash(runner, tokenHash),
    );
    if (!row) throw new PersonalAccessTokenNotAuthenticatedError('unknown');

    const usability = evaluateTokenUsability(
      { revokedAt: row.revokedAt, expiresAt: row.expiresAt },
      new Date(),
    );
    if (!usability.usable) {
      throw new PersonalAccessTokenNotAuthenticatedError(usability.reason ?? 'unknown');
    }

    await this.touch(row, correlationId);

    return {
      tokenId: row.id,
      organizationId: row.organizationId,
      membershipId: row.membershipId,
      userId: row.userId,
    };
  }

  /** Record the token's last use. Best-effort: scoped to its tenant, and never throws upward. */
  private async touch(row: PersonalAccessTokenAuthRow, correlationId: string): Promise<void> {
    try {
      const context = createServiceContext({
        organizationId: row.organizationId,
        correlationId,
        policyVersion: 'personal-access-token-usage',
      });
      await this.database.transaction(context, (tx) =>
        this.tokens.recordUsage(tx, context, row.id, new Date()),
      );
    } catch {
      // A failed usage timestamp is never the caller's problem; authentication already succeeded.
    }
  }

  private resolveExpiry(expiresInDays: number | null): Date | null {
    if (expiresInDays === null) return null;
    if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > MAX_EXPIRY_DAYS) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'expiresInDays', message: `must be an integer from 1 to ${MAX_EXPIRY_DAYS}` },
      ]);
    }
    return new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
  }

  static get maxNameLength(): number {
    return MAX_NAME_LENGTH;
  }
}
