import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  oauthAccessTokens,
  oauthClients,
  oauthGrants,
  orgFeatureFlags,
  users,
} from '../../common/database/schema.js';
import type {
  IdentityQueryRunner,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';

/**
 * Data access for the Connected apps page (MCP connector S11). Every grant query carries
 * `organization_id = context.organizationId`; a member's own view adds their membership, so a
 * grant from another workspace — or, for a member, another person's grant — is never listed or
 * revoked. Clients and access tokens are global tables reached through the grant ids just read.
 */

export interface ConnectedGrantRow {
  readonly id: string;
  readonly membershipId: string;
  readonly userId: string;
  readonly memberName: string;
  readonly clientName: string;
  readonly verified: boolean;
  readonly scopes: string;
  readonly createdAt: Date;
}

export class GrantsRepository {
  /** The live grants in this workspace; only `membershipId`'s when it is given. Newest first. */
  async listLive(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string | null,
  ): Promise<ConnectedGrantRow[]> {
    return tenantDrizzle(runner)
      .select({
        id: oauthGrants.id,
        membershipId: oauthGrants.membershipId,
        userId: oauthGrants.userId,
        memberName: users.displayName,
        clientName: oauthClients.name,
        verified: oauthClients.verified,
        scopes: oauthGrants.scopes,
        createdAt: oauthGrants.createdAt,
      })
      .from(oauthGrants)
      .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientPk))
      .innerJoin(users, eq(users.id, oauthGrants.userId))
      .where(
        and(
          eq(oauthGrants.organizationId, context.organizationId),
          isNull(oauthGrants.revokedAt),
          ...(membershipId === null ? [] : [eq(oauthGrants.membershipId, membershipId)]),
        ),
      )
      .orderBy(desc(oauthGrants.createdAt));
  }

  /**
   * When each grant last had a token issued — the "Last used" line. Tokens are refreshed every
   * 30 minutes while an app works, so this is as fine as the page needs without a write per call.
   */
  async lastTokenIssuedAt(
    runner: TenantQueryRunner,
    grantIds: readonly string[],
  ): Promise<Map<string, Date>> {
    const result = new Map<string, Date>();
    if (grantIds.length === 0) return result;
    const rows = await tenantDrizzle(runner)
      .select({
        grantId: oauthAccessTokens.grantId,
        last: sql<Date | string | null>`max(${oauthAccessTokens.createdAt})`,
      })
      .from(oauthAccessTokens)
      .where(inArray(oauthAccessTokens.grantId, [...grantIds]))
      .groupBy(oauthAccessTokens.grantId);
    for (const row of rows) {
      if (row.last !== null) result.set(row.grantId, new Date(row.last));
    }
    return result;
  }

  /**
   * Revoke one live grant in this workspace (only `membershipId`'s when it is given). Returns the
   * rows changed: `0` when it does not exist here, is someone else's, or was already revoked.
   */
  async revokeGrant(
    runner: TenantQueryRunner,
    context: TenantContext,
    grantId: string,
    membershipId: string | null,
  ): Promise<number> {
    const result = await tenantDrizzle(runner)
      .update(oauthGrants)
      .set({ revokedAt: sql`current_timestamp(3)` })
      .where(
        and(
          eq(oauthGrants.organizationId, context.organizationId),
          eq(oauthGrants.id, grantId),
          isNull(oauthGrants.revokedAt),
          ...(membershipId === null ? [] : [eq(oauthGrants.membershipId, membershipId)]),
        ),
      );
    return result[0].affectedRows;
  }

  /** The signed-in person's display name, for the "Owner view · <name>" line. */
  async displayName(runner: TenantQueryRunner, userId: string): Promise<string> {
    const rows = await tenantDrizzle(runner)
      .select({ name: users.displayName })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return rows[0]?.name ?? '';
  }
}

/**
 * The workspace's `ai_apps_off` flag row (S11 kill switch), or `null` when there is none. Runs on
 * a bootstrap runner on the token and `/mcp` paths, before a tenant context exists; the
 * organization predicate is still present.
 */
export async function findAiAppsOffRow(
  runner: IdentityQueryRunner,
  organizationId: string,
  flagKey: string,
): Promise<{ readonly enabled: boolean } | null> {
  const rows = await tenantDrizzle(runner)
    .select({ enabled: orgFeatureFlags.enabled })
    .from(orgFeatureFlags)
    .where(
      and(eq(orgFeatureFlags.organizationId, organizationId), eq(orgFeatureFlags.flagKey, flagKey)),
    )
    .limit(1);
  return rows[0] ?? null;
}
