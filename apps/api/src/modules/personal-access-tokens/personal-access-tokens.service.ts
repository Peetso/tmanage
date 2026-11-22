import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { createServiceContext } from '../../common/database/tenant-context.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { PersonalAccessTokenRow } from '../../common/database/schema.js';
import {
  DEFAULT_PAT_SCOPES,
  evaluateTokenUsability,
  hashAddress,
  hashPersonalAccessToken,
  isWellFormedPersonalAccessToken,
  mintPersonalAccessToken,
  parseStoredIpAllowlist,
  parseStoredScopes,
  isAgentScoped,
} from './personal-access-token.js';
import { KNOWN_SCOPES, scopesToString } from '../oauth/scopes.js';
import { validateIpAllowlist } from '../admin/cidr.js';
import { normalizePolicy, resolvePatPolicy } from '../admin/policies.allowlist.js';
import type { PatPolicy } from '../admin/policies.allowlist.js';
import { PoliciesRepository } from '../admin/policies.repository.js';
import { verifyReauthToken } from '../identity/reauth-token.js';
import { SessionsRepository } from '../identity/sessions.repository.js';
import { AuditEventsRepository } from '../audit/audit-events.repository.js';
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
  /** R13 s3. The scopes the token holds, in canonical order. */
  readonly scopes: readonly string[];
  /** R13 s3. The addresses / ranges it may be used from; empty means any. */
  readonly ipAllowlist: readonly string[];
}

/** The create response: the view plus the plaintext, returned exactly once. */
export interface CreatedPersonalAccessTokenView extends PersonalAccessTokenView {
  /** The plaintext token. Shown to the creator once and never retrievable again. */
  readonly token: string;
}

/** The identity a successfully authenticated token resolves to. */
export interface AuthenticatedToken {
  readonly tokenId: string;
  /** The token's own name, which its frozen actions are attributed to (TESTUX P1 9). */
  readonly name: string;
  readonly organizationId: string;
  readonly membershipId: string;
  readonly userId: string;
  /** R13 s3. The token's scopes; the guard refuses a route whose class they do not cover. */
  readonly scopes: readonly string[];
  /** R13 s3. Addresses / ranges the token may be used from; empty means any. */
  readonly ipAllowlist: readonly string[];
  /**
   * 60-06. The stored scopes name `tmanage:agent`: an AI employee's agent key. Its `scopes` are
   * empty (the agent scope is not a human scope), so only the agent tool wall decides its routes.
   */
  readonly agent: boolean;
}

export type PersonalAccessTokenRejection = 'malformed' | 'unknown' | 'revoked' | 'expired';

export class PersonalAccessTokenNotAuthenticatedError extends Error {
  constructor(readonly code: PersonalAccessTokenRejection) {
    super('The personal access token was not accepted');
    this.name = 'PersonalAccessTokenNotAuthenticatedError';
  }
}

const MAX_NAME_LENGTH = 190;
/** R13 s3. The expiry a token gets when the create names none. */
export const DEFAULT_EXPIRY_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/** R13 s3. What a create asks for, before the organization's token policy is applied. */
export interface PatCreateRequest {
  /** Requested scopes (array or space-separated string); omitted means read + write. */
  readonly scopes?: unknown;
  /** Days until expiry; `undefined` means the 90-day default, `null` means never. */
  readonly expiresInDays?: number | null | undefined;
  /** IPs / CIDR ranges; omitted or empty means any address. */
  readonly ipAllowlist?: unknown;
}

/** R13 s3. The checked values a create stores. */
export interface ResolvedPatCreate {
  readonly expiresAt: Date | null;
  readonly scopes: string;
  readonly ipAllowlistJson: string | null;
}

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The request body is invalid', [
    { field, message },
  ]);
}

function requestedScopes(raw: unknown, policy: PatPolicy): readonly string[] {
  if (raw === undefined || raw === null) {
    const scopes = DEFAULT_PAT_SCOPES.filter((scope) => policy.allowedScopes.includes(scope));
    if (scopes.length === 0) throw invalid('scopes', 'Choose the access this token needs.');
    return scopes;
  }
  const list: unknown[] | null =
    typeof raw === 'string'
      ? raw.split(/\s+/).filter((s) => s !== '')
      : Array.isArray(raw)
        ? (raw as unknown[])
        : null;
  if (list === null || list.length === 0 || list.some((s) => typeof s !== 'string')) {
    throw invalid('scopes', 'must be a non-empty list of scopes');
  }
  const names = list as string[];
  const unknown = names.find((scope) => !KNOWN_SCOPES.includes(scope));
  if (unknown !== undefined) throw invalid('scopes', `"${unknown}" is not a scope we recognise`);
  const outside = names.find((scope) => !policy.allowedScopes.includes(scope));
  if (outside !== undefined) {
    throw invalid('scopes', `Your company does not allow tokens with "${outside}".`);
  }
  return KNOWN_SCOPES.filter((scope) => names.includes(scope));
}

function requestedExpiry(
  expiresInDays: number | null | undefined,
  policy: PatPolicy,
  stepUpFresh: boolean,
  now: Date,
): Date | null {
  if (expiresInDays === null) {
    if (!policy.allowNoExpiry) {
      throw new ApiError(
        403,
        'forbidden',
        'Your company does not allow tokens that never expire. Choose an expiry date.',
        undefined,
        'pat_no_expiry_not_allowed',
      );
    }
    if (!stepUpFresh) {
      throw new ApiError(
        403,
        'reauthentication_required',
        'Confirm your password to create a token that never expires.',
        undefined,
        'pat_no_expiry_step_up',
      );
    }
    return null;
  }
  const days = expiresInDays ?? Math.min(DEFAULT_EXPIRY_DAYS, policy.maxExpiryDays);
  if (!Number.isInteger(days) || days < 1 || days > policy.maxExpiryDays) {
    throw invalid(
      'expiresInDays',
      `must be a whole number of days from 1 to ${policy.maxExpiryDays}`,
    );
  }
  return new Date(now.getTime() + days * DAY_MS);
}

/**
 * R13 s3 (56-09). Apply the organization's token policy to a create. Pure, so the rule is unit
 * tested without a database:
 *
 * - scopes: known scopes only, a subset of `pat.allowed_scopes`; omitted, read + write (narrowed to
 *   what the policy allows, refused if that leaves nothing);
 * - expiry: omitted is 90 days (capped by `pat.max_expiry_days`); a number must be 1..max; `null`
 *   (never) only when `pat.allow_no_expiry` is on AND the session proved the password just now;
 * - IP allowlist: validated and canonicalised by `admin/cidr.ts`; empty means any address.
 */
export function resolvePatCreate(
  request: PatCreateRequest,
  policy: PatPolicy,
  stepUpFresh: boolean,
  now: Date,
): ResolvedPatCreate {
  const scopes = requestedScopes(request.scopes, policy);
  const expiresAt = requestedExpiry(request.expiresInDays, policy, stepUpFresh, now);
  let ipAllowlistJson: string | null = null;
  if (request.ipAllowlist !== undefined && request.ipAllowlist !== null) {
    const verdict = validateIpAllowlist(request.ipAllowlist);
    if (!verdict.ok) throw invalid('ipAllowlist', verdict.message);
    ipAllowlistJson = verdict.value.length === 0 ? null : JSON.stringify(verdict.value);
  }
  return { expiresAt, scopes: scopesToString(scopes), ipAllowlistJson };
}

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
    scopes: parseStoredScopes(row.scopes),
    ipAllowlist: parseStoredIpAllowlist(row.ipAllowlistJson),
  };
}

export class PersonalAccessTokensService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly tokens: PersonalAccessTokensRepository = new PersonalAccessTokensRepository(),
    /** N04 (wave 10): read-only, to re-check the creating session after the insert commits. */
    private readonly sessions: SessionsRepository = new SessionsRepository(),
    /** R13 s3: the organization's access-policy document (token keys). */
    private readonly policies: Pick<PoliciesRepository, 'find'> = new PoliciesRepository(),
    /** R13 s3: verifies the `x-reauth-token` step-up; absent, no create counts as step-up fresh. */
    private readonly sessionSecret?: string,
    /** R14 b: token create/revoke rows in the organization's audit trail. */
    private readonly audit: Pick<AuditEventsRepository, 'append'> = new AuditEventsRepository(),
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
    input: PatCreateRequest & {
      name: string;
      sessionId?: string | undefined;
      /** R13 s3: the `x-reauth-token` header, needed only for a never-expiring token. */
      reauthToken?: string | undefined;
    },
  ): Promise<CreatedPersonalAccessTokenView> {
    const sessionId = input.sessionId;
    if (typeof sessionId !== 'string' || sessionId === '') throw sessionRevoked();
    const name = input.name.trim();
    if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'name', message: `must be 1 to ${MAX_NAME_LENGTH} characters` },
      ]);
    }
    const stepUpFresh = this.stepUpFresh(input.reauthToken, context.userId, sessionId);

    const minted = mintPersonalAccessToken();
    const row = await this.database.transaction(context, async (tx) => {
      // R13 s3: the organization's token policy decides scopes, expiry and the never-expiry case;
      // a refusal throws before the insert, so nothing is written.
      const stored = await this.policies.find(tx, context);
      const policy = resolvePatPolicy(normalizePolicy(stored?.policyJson));
      const resolved = resolvePatCreate(input, policy, stepUpFresh, new Date());
      const inserted = await this.tokens.insert(tx, context, {
        membershipId: principal.membershipId,
        userId: context.userId,
        name,
        tokenHash: minted.tokenHash,
        tokenPrefix: minted.displayPrefix,
        expiresAt: resolved.expiresAt,
        scopes: resolved.scopes,
        ipAllowlistJson: resolved.ipAllowlistJson,
      });
      // R14 b: identifiers and classifications only — never the token, its hash or its prefix.
      await this.audit.append(tx, context, {
        action: 'personal_access_token.created',
        result: 'allowed',
        objectId: inserted.id,
        metadata: {
          scopes: parseStoredScopes(resolved.scopes),
          never_expires: resolved.expiresAt === null,
          network_limited: resolved.ipAllowlistJson !== null,
        },
      });
      return inserted;
    });

    if (!(await this.sessionStillLive(context, sessionId))) {
      await this.database.transaction(context, async (tx) => {
        await this.tokens.revoke(tx, context, principal.membershipId, row.id, new Date());
        await this.audit.append(tx, context, {
          action: 'personal_access_token.revoked',
          result: 'allowed',
          objectId: row.id,
          metadata: { by: 'session_ended' },
        });
      });
      throw sessionRevoked();
    }
    return { ...toView(row), token: minted.token };
  }

  /** R13 s3: did this session prove the password in the last five minutes (`POST /v1/auth/reauth`)? */
  private stepUpFresh(token: string | undefined, userId: string, sessionId: string): boolean {
    if (this.sessionSecret === undefined || token === undefined) return false;
    const verified = verifyReauthToken(token, this.sessionSecret);
    return (
      verified.ok && verified.claims.userId === userId && verified.claims.sessionId === sessionId
    );
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
    const changed = await this.database.transaction(context, async (tx) => {
      const count = await this.tokens.revoke(
        tx,
        context,
        principal.membershipId,
        tokenId,
        new Date(),
      );
      if (count > 0) {
        await this.audit.append(tx, context, {
          action: 'personal_access_token.revoked',
          result: 'allowed',
          objectId: tokenId,
          metadata: { by: 'owner' },
        });
      }
      return count;
    });
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
  async authenticate(
    token: string,
    correlationId: string,
    ip: string | null = null,
  ): Promise<AuthenticatedToken> {
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

    await this.touch(row, correlationId, ip);

    return {
      tokenId: row.id,
      name: row.name,
      organizationId: row.organizationId,
      membershipId: row.membershipId,
      userId: row.userId,
      scopes: row.scopes === undefined ? DEFAULT_PAT_SCOPES : parseStoredScopes(row.scopes),
      ipAllowlist: parseStoredIpAllowlist(row.ipAllowlistJson),
      agent: isAgentScoped(row.scopes),
    };
  }

  /**
   * Record the token's last use and (R15, 0286) the hashed address it came from, in the same
   * one-way form the guard's allowlist refusal audit uses. Best-effort: scoped to its tenant, and
   * never throws upward.
   */
  private async touch(
    row: PersonalAccessTokenAuthRow,
    correlationId: string,
    ip: string | null,
  ): Promise<void> {
    try {
      const context = createServiceContext({
        organizationId: row.organizationId,
        correlationId,
        policyVersion: 'personal-access-token-usage',
      });
      await this.database.transaction(context, (tx) =>
        this.tokens.recordUsage(tx, context, row.id, new Date(), hashAddress(ip)),
      );
    } catch {
      // A failed usage timestamp is never the caller's problem; authentication already succeeded.
    }
  }

  static get maxNameLength(): number {
    return MAX_NAME_LENGTH;
  }
}
