import { capabilitySetFor } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { FeatureFlagsRepository } from '../admin/feature-flags.repository.js';
import { AI_APPS_OFF_FLAG, organizationAiAccessOn } from './ai-access.js';
import type { AiAccessSwitches } from './ai-access.js';
import { GrantsRepository } from './grants.repository.js';
import { OauthTokensRepository } from './oauth-tokens.repository.js';
import { KNOWN_SCOPES } from './scopes.js';
import { knownAiAppOf, openUrlOf } from './known-clients.js';
import type { KnownAiApp } from './known-clients.js';

/**
 * **Connected apps (MCP connector S11; architecture F4).** Lists the AI apps connected to a
 * workspace, disconnects one, and flips the workspace's "Allow AI apps" switch.
 *
 * - A **member** sees and revokes only the apps they connected themselves.
 * - An **owner** (`org.security.manage`) sees and revokes every app in the workspace, and is the
 *   only one who may turn AI off for it.
 *
 * Revoking marks the grant and every one of its access and refresh tokens revoked in one
 * transaction. Tokens are opaque and checked against the database on every use, so the next call
 * with any of them fails at once.
 */

export interface ConnectedAppView {
  readonly id: string;
  readonly clientName: string;
  readonly verified: boolean;
  /** The consented scopes, e.g. `['tmanage:read', 'tmanage:write']`, in a fixed order. */
  readonly scopes: readonly string[];
  readonly memberName: string;
  /** True when the signed-in person connected it. */
  readonly mine: boolean;
  readonly connectedAt: string;
  /** When a token was last issued to it; `null` when it has not been used yet. */
  readonly lastUsedAt: string | null;
}

export interface ConnectedAppsView {
  /** May the viewer see every connection and use the workspace switch? */
  readonly owner: boolean;
  readonly viewerName: string;
  /** The workspace switch: are AI apps allowed here? */
  readonly aiAccessEnabled: boolean;
  readonly apps: readonly ConnectedAppView[];
}

/**
 * AI panel: one of the signed-in member's own connected AI apps. `app` and `openUrl` come from the
 * verified client id ({@link knownAiAppOf}), never from `clientName`.
 */
export interface AiPanelAppView {
  readonly grantId: string;
  readonly clientName: string;
  readonly verified: boolean;
  /** The recognised app, or `null`: the panel then shows the neutral mark. */
  readonly app: KnownAiApp | null;
  /** Where "Open" goes; `null` = no "Open" (Cursor, every unrecognised app). */
  readonly openUrl: string | null;
  readonly connectedAt: string;
  readonly lastUsedAt: string | null;
}

/** An AI client as the activity list names it: its registered name and recognised app. */
export interface AiClientLabel {
  readonly clientName: string;
  readonly app: KnownAiApp | null;
}

/** The capability that makes the viewer the workspace's AI owner. */
export const AI_OWNER_CAPABILITY = 'org.security.manage' as const;

/**
 * Is this membership role an owner for the Connected apps page? Pure. The role is the principal
 * role the membership resolver built, so a custom role (H1) is judged by its own loaded set; a
 * raw or unknown value holds nothing.
 */
export function isAiOwner(role: string | undefined): boolean {
  return role !== undefined && capabilitySetFor(role).has(AI_OWNER_CAPABILITY);
}

/** The stored space-separated scopes as a list in the canonical display order. Pure. */
export function orderedScopes(stored: string): string[] {
  const present = new Set(stored.split(/\s+/).filter(Boolean));
  return KNOWN_SCOPES.filter((scope) => present.has(scope));
}

export class ConnectedAppsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly switches: AiAccessSwitches,
    private readonly grants = new GrantsRepository(),
    private readonly tokens = new OauthTokensRepository(),
    private readonly flags = new FeatureFlagsRepository(),
  ) {}

  async list(context: TenantContext, owner: boolean): Promise<ConnectedAppsView> {
    return this.database.read(context, async (runner) => {
      const rows = await this.grants.listLive(runner, context, owner ? null : context.membershipId);
      const lastUsed = await this.grants.lastTokenIssuedAt(
        runner,
        rows.map((row) => row.id),
      );
      const flag = await this.flags.findByKey(runner, context, AI_APPS_OFF_FLAG);
      const viewerName = await this.grants.displayName(runner, context.userId);
      return {
        owner,
        viewerName,
        aiAccessEnabled: organizationAiAccessOn(flag ? { enabled: flag.enabled } : null),
        apps: rows.map((row) => ({
          id: row.id,
          clientName: row.clientName,
          verified: row.verified,
          scopes: orderedScopes(row.scopes),
          memberName: row.memberName,
          mine: row.membershipId === context.membershipId,
          connectedAt: row.createdAt.toISOString(),
          lastUsedAt: lastUsed.get(row.id)?.toISOString() ?? null,
        })),
      };
    });
  }

  /** AI panel: the member's own live connections, newest first, with the recognised app. */
  async ownApps(context: TenantContext): Promise<AiPanelAppView[]> {
    return this.database.read(context, async (runner) => {
      const rows = await this.grants.listLive(runner, context, context.membershipId);
      const lastUsed = await this.grants.lastTokenIssuedAt(
        runner,
        rows.map((row) => row.id),
      );
      return rows.map((row) => {
        const app = knownAiAppOf({
          kind: row.clientKind,
          clientId: row.clientId,
          verified: row.verified,
        });
        return {
          grantId: row.id,
          clientName: row.clientName,
          verified: row.verified,
          app,
          openUrl: openUrlOf(app),
          connectedAt: row.createdAt.toISOString(),
          lastUsedAt: lastUsed.get(row.id)?.toISOString() ?? null,
        };
      });
    });
  }

  /** AI panel: the clients MCP audit rows name (by `oauth_clients.id`), granted here. */
  async clientLabels(
    context: TenantContext,
    clientPks: readonly string[],
  ): Promise<Map<string, AiClientLabel>> {
    const rows = await this.database.read(context, (runner) =>
      this.grants.clientsGrantedHere(runner, context, clientPks),
    );
    return new Map(
      rows.map((row) => [
        row.id,
        {
          clientName: row.name,
          app: knownAiAppOf({ kind: row.kind, clientId: row.clientId, verified: row.verified }),
        },
      ]),
    );
  }

  /** Disconnect one app: the grant and all its tokens, in one transaction. 404 when not yours. */
  async revoke(context: TenantContext, owner: boolean, grantId: string): Promise<void> {
    await this.database.transaction(context, async (tx) => {
      const changed = await this.grants.revokeGrant(
        tx,
        context,
        grantId,
        owner ? null : context.membershipId,
      );
      if (changed !== 1) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      await this.tokens.revokeTokensByGrant(tx, grantId);
    });
  }

  /** The owner's workspace switch. Takes effect on the next AI call. */
  async setAiAccess(
    context: TenantContext,
    enabled: unknown,
  ): Promise<{ aiAccessEnabled: boolean }> {
    if (typeof enabled !== 'boolean') {
      throw new ApiError(400, 'validation_failed', 'Choose on or off.', [
        { field: 'enabled', message: 'must be a boolean' },
      ]);
    }
    await this.database.transaction(context, (tx) =>
      this.flags.upsert(tx, context, {
        flagKey: AI_APPS_OFF_FLAG,
        enabled: !enabled,
        updatedBy: context.membershipId,
      }),
    );
    this.switches.forget();
    return { aiAccessEnabled: enabled };
  }
}
