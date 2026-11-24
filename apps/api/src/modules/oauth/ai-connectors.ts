import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { GrantsRepository } from './grants.repository.js';
import { OauthTokensRepository } from './oauth-tokens.repository.js';

/**
 * 60-07 (plan 60 v2 §4.5) — connectors that work as an AI employee: OAuth grants whose membership
 * is the AI employee's, made on the consent page by its sponsor or a holder of
 * `ai_employee.manage` (`works-as.ts`). This module owns `oauth_grants` and the token tables, so
 * the AI-employee module reaches them only through this service (AR-5, AR-7), the way it reaches
 * agent keys through `AgentKeysService`. Every method runs in the caller's transaction or read,
 * so the "who may bind" check, the cap and the audit row commit with the change (DA-1, DA-11).
 */

/** One live connector as the AI employee's Connections tab lists it. */
export interface AiConnectorRecord {
  readonly grantId: string;
  /** The app's registered name ("Claude"). */
  readonly clientName: string;
  readonly createdAt: Date;
  readonly authorizedByMembershipId: string | null;
  readonly authorizedByName: string | null;
  /** When a token was last issued under it (refreshed every 30 minutes while the app works). */
  readonly lastUsedAt: Date | null;
}

export interface AiConnectorSummary {
  readonly live: number;
  readonly lastUsedAt: Date | null;
}

export class AiConnectorsService {
  constructor(
    private readonly grants: Pick<
      GrantsRepository,
      'listLiveForMembership' | 'connectorSummaries' | 'lastTokenIssuedAt' | 'revokeGrant'
    > = new GrantsRepository(),
    private readonly tokens: Pick<
      OauthTokensRepository,
      'revokeTokensByGrant'
    > = new OauthTokensRepository(),
  ) {}

  /** The membership's live connectors, newest first. */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<readonly AiConnectorRecord[]> {
    const rows = await this.grants.listLiveForMembership(runner, context, membershipId);
    const lastUsed = await this.grants.lastTokenIssuedAt(
      runner,
      rows.map((row) => row.id),
    );
    return rows.map((row) => ({
      grantId: row.id,
      clientName: row.clientName,
      createdAt: row.createdAt,
      authorizedByMembershipId: row.authorizedByMembershipId,
      authorizedByName: row.authorizedByName,
      lastUsedAt: lastUsed.get(row.id) ?? null,
    }));
  }

  /** Live connectors and last use per membership, one read for many memberships. */
  async summaries(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipIds: readonly string[],
  ): Promise<ReadonlyMap<string, AiConnectorSummary>> {
    const rows = await this.grants.connectorSummaries(runner, context, membershipIds);
    return new Map(
      rows.map((row) => [row.membershipId, { live: row.live, lastUsedAt: row.lastUsedAt }]),
    );
  }

  async countLive(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<number> {
    return (await this.summaries(runner, context, [membershipId])).get(membershipId)?.live ?? 0;
  }

  /**
   * Stop one connector now: the grant and every access and refresh token under it, in the
   * caller's transaction. `false` when the grant is not this membership's, is in another
   * workspace, or was already revoked.
   */
  async revoke(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    grantId: string,
  ): Promise<boolean> {
    const changed = await this.grants.revokeGrant(runner, context, grantId, membershipId);
    if (changed !== 1) return false;
    await this.tokens.revokeTokensByGrant(runner, grantId);
    return true;
  }

  /**
   * Retire: stop every live connector of this membership, each grant with all its tokens, in the
   * caller's transaction. Returns the grant ids revoked now (for the audit row).
   */
  async revokeAll(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<readonly string[]> {
    const live = await this.grants.listLiveForMembership(runner, context, membershipId);
    const revoked: string[] = [];
    for (const row of live) {
      if (await this.revoke(runner, context, membershipId, row.id)) revoked.push(row.id);
    }
    return revoked;
  }
}
