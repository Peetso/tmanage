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
  BootstrapQueryRunner,
  IdentityQueryRunner,
  QueryRows,
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
  /** The client's row id (`oauth_clients.id`), the id an MCP audit row names it by. */
  readonly clientPk: string;
  /** The OAuth `client_id` (a CIMD URL or a DCR id) and its kind, for the known-app table. */
  readonly clientId: string;
  readonly clientKind: string;
}

/** One OAuth client as the AI panel names it. */
export interface OauthClientIdentityRow {
  readonly id: string;
  readonly name: string;
  readonly clientId: string;
  readonly kind: string;
  readonly verified: boolean;
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
        clientPk: oauthClients.id,
        clientId: oauthClients.clientId,
        clientKind: oauthClients.kind,
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

  /**
   * F19 (wave 9). The organizations in which this person still holds a live grant — the first
   * half of the per-user bearer cutoff a recovery action applies. Tenant-free by necessity, so it
   * runs on the audited, read-only bootstrap runner and returns organization ids only.
   */
  async listOrganizationsWithLiveGrants(
    runner: BootstrapQueryRunner,
    userId: string,
  ): Promise<readonly string[]> {
    const rows = (await runner.query(
      `SELECT DISTINCT organization_id
         FROM oauth_grants
        WHERE user_id = ?
          AND revoked_at IS NULL`,
      [userId],
    )) as QueryRows;
    return rows.map((row) => String(row['organization_id']));
  }

  /**
   * F19 (wave 9). Revoke every live grant this person holds in the acting tenant, and return the
   * ids of all their grants here (live or already revoked) so the caller can end the access and
   * refresh tokens issued under them. Scoped on `organization_id` like every tenant write.
   */
  async revokeAllForUser(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId: string,
  ): Promise<readonly string[]> {
    const owned = await tenantDrizzle(runner)
      .select({ id: oauthGrants.id })
      .from(oauthGrants)
      .where(
        and(eq(oauthGrants.organizationId, context.organizationId), eq(oauthGrants.userId, userId)),
      );
    await tenantDrizzle(runner)
      .update(oauthGrants)
      .set({ revokedAt: sql`current_timestamp(3)` })
      .where(
        and(
          eq(oauthGrants.organizationId, context.organizationId),
          eq(oauthGrants.userId, userId),
          isNull(oauthGrants.revokedAt),
        ),
      );
    return owned.map((row) => row.id);
  }

  /**
   * The clients granted in this workspace, by row id: the ones the member's MCP audit rows name.
   * Reached through `oauth_grants` (tenant-owned, `organization_id` first), so a client that never
   * had a grant here names nothing; revoked grants count, so an old row keeps its app's name.
   */
  async clientsGrantedHere(
    runner: TenantQueryRunner,
    context: TenantContext,
    clientPks: readonly string[],
  ): Promise<OauthClientIdentityRow[]> {
    if (clientPks.length === 0) return [];
    return tenantDrizzle(runner)
      .selectDistinct({
        id: oauthClients.id,
        name: oauthClients.name,
        clientId: oauthClients.clientId,
        kind: oauthClients.kind,
        verified: oauthClients.verified,
      })
      .from(oauthGrants)
      .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientPk))
      .where(
        and(
          eq(oauthGrants.organizationId, context.organizationId),
          inArray(oauthGrants.clientPk, [...clientPks]),
        ),
      );
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
