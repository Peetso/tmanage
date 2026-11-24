import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import type {
  IdentityQueryRunner,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import {
  oauthAccessTokens,
  oauthClients,
  oauthCodes,
  oauthGrants,
  oauthRefreshTokens,
} from '../../common/database/schema.js';
import type {
  OauthAccessTokenRow,
  OauthClientRow,
  OauthCodeRow,
  OauthRefreshTokenRow,
} from '../../common/database/schema.js';

/**
 * Data access for the OAuth authorization server (0208, MCP connector S7).
 *
 * The four hash-keyed tables (`oauth_clients`, `oauth_codes`, `oauth_access_tokens`,
 * `oauth_refresh_tokens`) are global and reached on the identity path. `oauth_grants` is
 * tenant-owned: it is INSERTed under a tenant context (consent), and READ on the public token
 * path through `bootstrapRead` with a mandatory reason. Every method takes the runner the caller
 * opened, so the transaction boundary stays with the service.
 *
 * Every time comparison is made **in the database** on one clock — `expires_at` is written as
 * `now + ttl` and read as `> now` — the lesson `password_reset_tokens` and `invitations` record.
 * No method returns or accepts a plaintext secret; callers pass the SHA-256 hex.
 */

/** The global tables the OAuth identity path is permitted to touch (all but `oauth_grants`). */
export const OAUTH_IDENTITY_TABLES = [
  'oauth_clients',
  'oauth_codes',
  'oauth_access_tokens',
  'oauth_refresh_tokens',
] as const;

/** Why the one unscoped grant read skips the tenant predicate (passed to `bootstrapRead`). */
export const OAUTH_GRANT_BOOTSTRAP_REASON =
  'resolving which grant, membership and organization a presented OAuth token belongs to';

/** A runner that can issue statements — a tenant tx runner, a bootstrap runner, or identity. */
type Runner = IdentityQueryRunner;

export interface NewGrant {
  readonly id: string;
  readonly organizationId: string;
  readonly clientPk: string;
  readonly membershipId: string;
  readonly userId: string;
  readonly scopes: string;
  /** ADR-0015 F1: set only with `tmanage:platform` (the consent step-up session and window end). */
  readonly platformStepUpSessionId?: string | null;
  readonly platformUntil?: Date | null;
  /**
   * 60-07 (plan 60 v2 §4.5, 0400): the person who consented when the grant works as an AI
   * employee (`membershipId` is then the AI employee's); absent for a person's own grant.
   */
  readonly authorizedByMembershipId?: string | null;
}

export interface GrantView {
  readonly id: string;
  readonly organizationId: string;
  readonly clientPk: string;
  readonly membershipId: string;
  readonly userId: string;
  readonly scopes: string;
  readonly revokedAt: Date | null;
  readonly platformStepUpSessionId?: string | null;
  readonly platformUntil?: Date | null;
}

export interface NewOauthClient {
  readonly id: string;
  readonly clientId: string;
  readonly kind: 'dcr' | 'cimd';
  readonly name: string;
  readonly redirectUris: readonly string[];
  readonly verified: boolean;
  /** SHA-256 of the registering IP for DCR; NULL for a CIMD client (no registering IP). */
  readonly createdIpHash: string | null;
}

export class OauthTokensRepository {
  // ── Clients ──────────────────────────────────────────────────────────────

  async findClientByClientId(runner: Runner, clientId: string): Promise<OauthClientRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, clientId))
      .limit(1);
    return rows[0] ?? null;
  }

  async touchClient(runner: Runner, id: string): Promise<void> {
    await tenantDrizzle(runner)
      .update(oauthClients)
      .set({ lastUsedAt: sql`current_timestamp(3)` })
      .where(eq(oauthClients.id, id));
  }

  /** Create a client (DCR registration or a freshly fetched CIMD document). MCP connector S8. */
  async insertClient(runner: Runner, input: NewOauthClient): Promise<void> {
    await tenantDrizzle(runner)
      .insert(oauthClients)
      .values({
        id: input.id,
        clientId: input.clientId,
        kind: input.kind,
        name: input.name,
        redirectUrisJson: [...input.redirectUris],
        verified: input.verified,
        createdIpHash: input.createdIpHash,
        createdAt: sql`current_timestamp(3)`,
      });
  }

  /** Refresh a cached CIMD client's name/redirects/verified, and mark it used (24 h cache, S8). */
  async refreshCimdClient(
    runner: Runner,
    input: {
      readonly id: string;
      readonly name: string;
      readonly redirectUris: readonly string[];
      readonly verified: boolean;
    },
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(oauthClients)
      .set({
        name: input.name,
        redirectUrisJson: [...input.redirectUris],
        verified: input.verified,
        lastUsedAt: sql`current_timestamp(3)`,
      })
      .where(eq(oauthClients.id, input.id));
  }

  /**
   * How many clients this IP hash has registered in the last `withinSeconds`. The DCR rate limit
   * (threat model B1: 10 per IP per hour) is enforced in the database, not in process, so it
   * survives the single API process restarting — the same durability the sign-in lockout buys.
   */
  async countClientsByIpHashSince(
    runner: Runner,
    ipHash: string,
    withinSeconds: number,
  ): Promise<number> {
    const rows = await tenantDrizzle(runner)
      .select({ n: sql<number>`count(*)` })
      .from(oauthClients)
      .where(
        and(
          eq(oauthClients.createdIpHash, ipHash),
          gt(
            oauthClients.createdAt,
            sql`date_sub(current_timestamp(3), interval ${withinSeconds} second)`,
          ),
        ),
      );
    return Number(rows[0]?.n ?? 0);
  }

  /** How many DCR clients were registered overall in the last `withinSeconds` (B1: 1000/day). */
  async countDcrClientsSince(runner: Runner, withinSeconds: number): Promise<number> {
    const rows = await tenantDrizzle(runner)
      .select({ n: sql<number>`count(*)` })
      .from(oauthClients)
      .where(
        and(
          eq(oauthClients.kind, 'dcr'),
          gt(
            oauthClients.createdAt,
            sql`date_sub(current_timestamp(3), interval ${withinSeconds} second)`,
          ),
        ),
      );
    return Number(rows[0]?.n ?? 0);
  }

  // ── Grants ───────────────────────────────────────────────────────────────

  /**
   * Create a grant. Written under a tenant context (the consent decision), so the tenant runner
   * binds `organization_id` to the active organization — the grant cannot be minted for another
   * tenant than the one the signed-in user consented in.
   */
  async insertGrant(runner: TenantQueryRunner, input: NewGrant): Promise<void> {
    await tenantDrizzle(runner)
      .insert(oauthGrants)
      .values({
        id: input.id,
        organizationId: input.organizationId,
        clientPk: input.clientPk,
        membershipId: input.membershipId,
        userId: input.userId,
        scopes: input.scopes,
        platformStepUpSessionId: input.platformStepUpSessionId ?? null,
        platformUntil: input.platformUntil ?? null,
        authorizedByMembershipId: input.authorizedByMembershipId ?? null,
        createdAt: sql`current_timestamp(3)`,
      });
  }

  /** Read a grant by id. On the public token path this runs through `bootstrapRead`. */
  async findGrantById(runner: Runner, grantId: string): Promise<GrantView | null> {
    const rows = await tenantDrizzle(runner)
      .select({
        id: oauthGrants.id,
        organizationId: oauthGrants.organizationId,
        clientPk: oauthGrants.clientPk,
        membershipId: oauthGrants.membershipId,
        userId: oauthGrants.userId,
        scopes: oauthGrants.scopes,
        revokedAt: oauthGrants.revokedAt,
        platformStepUpSessionId: oauthGrants.platformStepUpSessionId,
        platformUntil: oauthGrants.platformUntil,
      })
      .from(oauthGrants)
      .where(eq(oauthGrants.id, grantId))
      .limit(1);
    return rows[0] ?? null;
  }

  // ── Authorization codes ────────────────────────────────────────────────────

  async insertCode(
    runner: Runner,
    input: {
      readonly codeHash: string;
      readonly grantId: string;
      readonly challenge: string;
      readonly redirectUri: string;
      readonly resource: string;
      readonly ttlSeconds: number;
    },
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(oauthCodes)
      .values({
        codeHash: input.codeHash,
        grantId: input.grantId,
        challenge: input.challenge,
        redirectUri: input.redirectUri,
        resource: input.resource,
        expiresAt: sql`date_add(current_timestamp(3), interval ${input.ttlSeconds} second)`,
        createdAt: sql`current_timestamp(3)`,
      });
  }

  async findCodeByHash(runner: Runner, codeHash: string): Promise<OauthCodeRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(oauthCodes)
      .where(eq(oauthCodes.codeHash, codeHash))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Spend a code. The compare-and-set — update `used_at` only where it is still NULL and the code
   * has not expired — is what makes it single-use: two token requests racing one code both read it
   * live, and exactly one update wins. `false` means it was already spent or has expired.
   */
  async spendCode(runner: Runner, codeHash: string): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(oauthCodes)
      .set({ usedAt: sql`current_timestamp(3)` })
      .where(
        and(
          eq(oauthCodes.codeHash, codeHash),
          isNull(oauthCodes.usedAt),
          gt(oauthCodes.expiresAt, sql`current_timestamp(3)`),
        ),
      );
    return result[0].affectedRows === 1;
  }

  // ── Access tokens ──────────────────────────────────────────────────────────

  async insertAccessToken(
    runner: Runner,
    input: {
      readonly tokenHash: string;
      readonly grantId: string;
      readonly familyId: string;
      readonly audience: string;
      readonly scopes: string;
      readonly ttlSeconds: number;
    },
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(oauthAccessTokens)
      .values({
        tokenHash: input.tokenHash,
        grantId: input.grantId,
        familyId: input.familyId,
        audience: input.audience,
        scopes: input.scopes,
        expiresAt: sql`date_add(current_timestamp(3), interval ${input.ttlSeconds} second)`,
        createdAt: sql`current_timestamp(3)`,
      });
  }

  async findLiveAccessTokenByHash(
    runner: Runner,
    tokenHash: string,
  ): Promise<OauthAccessTokenRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(oauthAccessTokens)
      .where(
        and(
          eq(oauthAccessTokens.tokenHash, tokenHash),
          isNull(oauthAccessTokens.revokedAt),
          gt(oauthAccessTokens.expiresAt, sql`current_timestamp(3)`),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  // ── Refresh tokens ─────────────────────────────────────────────────────────

  async insertRefreshToken(
    runner: Runner,
    input: {
      readonly tokenHash: string;
      readonly familyId: string;
      readonly grantId: string;
      readonly parentHash: string | null;
      readonly idleTtlSeconds: number;
      /** When NULL the absolute expiry is set to first-issue + absoluteTtl; else carried forward. */
      readonly absoluteExpiresAt: Date | null;
      readonly absoluteTtlSeconds: number;
    },
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(oauthRefreshTokens)
      .values({
        tokenHash: input.tokenHash,
        familyId: input.familyId,
        grantId: input.grantId,
        parentHash: input.parentHash,
        expiresAt: sql`date_add(current_timestamp(3), interval ${input.idleTtlSeconds} second)`,
        absoluteExpiresAt:
          input.absoluteExpiresAt === null
            ? sql`date_add(current_timestamp(3), interval ${input.absoluteTtlSeconds} second)`
            : input.absoluteExpiresAt,
        createdAt: sql`current_timestamp(3)`,
      });
  }

  async findRefreshTokenByHash(
    runner: Runner,
    tokenHash: string,
  ): Promise<OauthRefreshTokenRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.tokenHash, tokenHash))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Mark a refresh token as used. Single-use compare-and-set: succeeds only while `used_at` is
   * still NULL and the token is neither revoked nor past either expiry. `false` means the token
   * was already used (which the caller treats as reuse), revoked, or expired.
   */
  async spendRefreshToken(runner: Runner, tokenHash: string): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(oauthRefreshTokens)
      .set({ usedAt: sql`current_timestamp(3)` })
      .where(
        and(
          eq(oauthRefreshTokens.tokenHash, tokenHash),
          isNull(oauthRefreshTokens.usedAt),
          isNull(oauthRefreshTokens.revokedAt),
          gt(oauthRefreshTokens.expiresAt, sql`current_timestamp(3)`),
          gt(oauthRefreshTokens.absoluteExpiresAt, sql`current_timestamp(3)`),
        ),
      );
    return result[0].affectedRows === 1;
  }

  /**
   * Revoke a whole token family — both the access tokens and the refresh tokens that share a
   * `family_id`. This is reuse detection (threat model B1) and the public `/oauth/revoke`
   * (RFC 7009): revoking any member of a family kills the family in one step. Only the live rows
   * are touched, so it is idempotent.
   */
  async revokeFamily(runner: Runner, familyId: string): Promise<void> {
    await tenantDrizzle(runner)
      .update(oauthAccessTokens)
      .set({ revokedAt: sql`current_timestamp(3)` })
      .where(and(eq(oauthAccessTokens.familyId, familyId), isNull(oauthAccessTokens.revokedAt)));
    await tenantDrizzle(runner)
      .update(oauthRefreshTokens)
      .set({ revokedAt: sql`current_timestamp(3)` })
      .where(and(eq(oauthRefreshTokens.familyId, familyId), isNull(oauthRefreshTokens.revokedAt)));
  }

  /**
   * Revoke every live token issued under a grant. Used when an authorization code is replayed:
   * "a second use of a code revokes the tokens it issued" (threat model B1). Stricter than the
   * letter of that rule — it revokes the grant's whole token set — which is the safe direction.
   */
  async revokeTokensByGrant(runner: Runner, grantId: string): Promise<void> {
    await tenantDrizzle(runner)
      .update(oauthAccessTokens)
      .set({ revokedAt: sql`current_timestamp(3)` })
      .where(and(eq(oauthAccessTokens.grantId, grantId), isNull(oauthAccessTokens.revokedAt)));
    await tenantDrizzle(runner)
      .update(oauthRefreshTokens)
      .set({ revokedAt: sql`current_timestamp(3)` })
      .where(and(eq(oauthRefreshTokens.grantId, grantId), isNull(oauthRefreshTokens.revokedAt)));
  }

  /** The family a presented access token belongs to, whatever its state — for `/oauth/revoke`. */
  async findAnyAccessTokenByHash(
    runner: Runner,
    tokenHash: string,
  ): Promise<OauthAccessTokenRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(oauthAccessTokens)
      .where(eq(oauthAccessTokens.tokenHash, tokenHash))
      .limit(1);
    return rows[0] ?? null;
  }
}
