import { and, desc, eq, isNull } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { personalAccessTokens } from '../../common/database/schema.js';
import type { PersonalAccessTokenRow } from '../../common/database/schema.js';
import type {
  BootstrapQueryRunner,
  QueryRows,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';

/**
 * The data half of personal access tokens.
 *
 * Two kinds of access live here, kept apart on purpose:
 *
 *   - **Tenant-scoped management** — list, create and revoke a member's own tokens. Every query
 *     carries `organization_id = context.organizationId` and `membership_id`, exactly like every
 *     other tenant repository, so a member only ever reaches their own tokens in their own org.
 *
 *   - **The authentication lookup** — {@link findUsableByHash}. The member is not yet known when a
 *     Bearer token arrives, so this one read has no tenant predicate and runs on the bootstrap
 *     runner (the same escape hatch session authentication and invitation acceptance use). It is
 *     read-only and keyed by the unique `token_hash`, so it resolves exactly one row.
 */

export interface InsertPersonalAccessTokenInput {
  readonly membershipId: string;
  readonly userId: string;
  readonly name: string;
  readonly tokenHash: string;
  readonly tokenPrefix: string;
  /** The creator-chosen expiry, or `null` for a token that does not expire. */
  readonly expiresAt: Date | null;
}

/** The fields the authentication path needs from a token row, resolved tenant-free by hash. */
export interface PersonalAccessTokenAuthRow {
  readonly id: string;
  readonly organizationId: string;
  readonly membershipId: string;
  readonly userId: string;
  readonly revokedAt: Date | null;
  readonly expiresAt: Date | null;
}

export class PersonalAccessTokensRepository {
  /** A member's own tokens in the acting tenant, newest first (UUIDv7 ids sort in creation order). */
  async listForMembership(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<readonly PersonalAccessTokenRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(personalAccessTokens)
      .where(
        and(
          eq(personalAccessTokens.organizationId, context.organizationId),
          eq(personalAccessTokens.membershipId, membershipId),
        ),
      )
      .orderBy(desc(personalAccessTokens.id));
  }

  /** One of a member's own tokens by id, if present in the acting tenant. */
  async findForMembership(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    tokenId: string,
  ): Promise<PersonalAccessTokenRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(personalAccessTokens)
      .where(
        and(
          eq(personalAccessTokens.organizationId, context.organizationId),
          eq(personalAccessTokens.membershipId, membershipId),
          eq(personalAccessTokens.id, tokenId),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /**
   * Insert a token for the acting tenant and membership. The id is generated here (UUIDv7);
   * `organization_id` comes from the context, never from the input. The composite foreign key
   * refuses a membership from another tenant, but the service has already resolved the acting
   * membership from the context, so no cross-tenant id reaches here.
   */
  async insert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: InsertPersonalAccessTokenInput,
  ): Promise<PersonalAccessTokenRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();
    await db.insert(personalAccessTokens).values({
      id,
      organizationId: context.organizationId,
      membershipId: input.membershipId,
      userId: input.userId,
      name: input.name,
      tokenHash: input.tokenHash,
      tokenPrefix: input.tokenPrefix,
      expiresAt: input.expiresAt,
      createdAt: sql`current_timestamp(3)`,
    });
    const rows = await db
      .select()
      .from(personalAccessTokens)
      .where(
        and(
          eq(personalAccessTokens.organizationId, context.organizationId),
          eq(personalAccessTokens.id, id),
        ),
      )
      .limit(1);
    return rows[0] as PersonalAccessTokenRow;
  }

  /**
   * Revoke one of a member's own live tokens, scoped on `(organization_id, membership_id, id)` and
   * `revoked_at IS NULL`. Returns how many rows changed, so the service can tell "revoked just now"
   * from "already revoked or not found" (0).
   */
  async revoke(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    tokenId: string,
    now: Date,
  ): Promise<number> {
    const result = await tenantDrizzle(runner)
      .update(personalAccessTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(personalAccessTokens.organizationId, context.organizationId),
          eq(personalAccessTokens.membershipId, membershipId),
          eq(personalAccessTokens.id, tokenId),
          isNull(personalAccessTokens.revokedAt),
        ),
      );
    return result[0].affectedRows;
  }

  /**
   * Resolve a token by its hash, tenant-free, for the authentication path. One indexed read on the
   * unique `token_hash`; the usability verdict (revoked/expired) is applied by the service. Raw SQL
   * on the bootstrap runner because no `TenantContext` exists yet — the member is what this read is
   * establishing.
   */
  async findUsableByHash(
    runner: BootstrapQueryRunner,
    tokenHash: string,
  ): Promise<PersonalAccessTokenAuthRow | undefined> {
    const rows = (await runner.query(
      `SELECT id, organization_id, membership_id, user_id, revoked_at, expires_at
         FROM personal_access_tokens
        WHERE token_hash = ?
        LIMIT 1`,
      [tokenHash],
    )) as QueryRows;
    const row = rows[0];
    if (!row) return undefined;
    return {
      id: String(row['id']),
      organizationId: String(row['organization_id']),
      membershipId: String(row['membership_id']),
      userId: String(row['user_id']),
      revokedAt:
        row['revoked_at'] == null ? null : new Date(row['revoked_at'] as string | number | Date),
      expiresAt:
        row['expires_at'] == null ? null : new Date(row['expires_at'] as string | number | Date),
    };
  }

  /**
   * Record that a token was just used, scoped to its own tenant. Best-effort: the caller runs it
   * after authentication succeeds and swallows any failure, so a failed touch never costs a request.
   */
  async recordUsage(
    runner: TenantQueryRunner,
    context: TenantContext,
    tokenId: string,
    now: Date,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(personalAccessTokens)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(personalAccessTokens.organizationId, context.organizationId),
          eq(personalAccessTokens.id, tokenId),
        ),
      );
  }
}
