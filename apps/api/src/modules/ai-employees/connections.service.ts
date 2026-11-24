import { AI_EMPLOYEE_MAX_LIVE_CREDENTIALS, type Principal } from '@tmanage/domain';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { ApiError } from '../../common/http/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import type { AiConnectorsService } from '../oauth/ai-connectors.js';
import type { AgentKeysService } from '../personal-access-tokens/agent-keys.js';
import type { AiEmployeeRecord, AiEmployeesRepository } from './ai-employees.repository.js';
import { requireMayBind, requirePersonSession } from './ai-employees.service.js';
import { aiEmployeesOff } from './ai-employees.switch.js';
import { memberDisplayNames } from './connections.repository.js';
import { AI_CONNECTOR_AUDIT } from './works-as.js';

/**
 * 60-07 (plan 60 v2 §4.5; screen S6b "Connections") — every live credential of one AI employee in
 * one list: its agent keys and the connectors that work as it, with who added each, its last use
 * and its end, and the cap of three live credentials counted over both kinds.
 *
 * The same door as the key routes: the server switch (off: 404 before anything is read), a
 * person's cookie session only (`requirePersonSession`), the sponsor or a holder of
 * `ai_employee.manage` (`requireMayBind`). Stopping a connector is allowed in every status, a
 * retired AI employee included (revoking always works, §4.5), and commits the grant's revocation,
 * its tokens' and the audit row in one transaction (DA-11).
 */

/** One connection, exactly as `AiEmployeeConnectionView` in `apps/web/src/lib/api/ai-employees.ts`. */
export interface AiEmployeeConnectionView {
  readonly id: string;
  readonly kind: 'key' | 'connector';
  readonly name: string;
  readonly tokenPrefix: string | null;
  readonly addedBy: { readonly membershipId: string | null; readonly displayName: string | null };
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly expiresAt: string | null;
  readonly live: boolean;
}

export interface AiEmployeeConnectionListView {
  readonly connections: readonly AiEmployeeConnectionView[];
  readonly limit: number;
  readonly live: number;
  /** AR-9: may the caller add one more key now (not retired, under the cap)? */
  readonly canCreate: boolean;
}

export interface AiEmployeeConnectionsServiceOptions {
  readonly database: Pick<TenantDatabase, 'read' | 'transaction'>;
  readonly audit: Pick<AuditService, 'record'>;
  readonly repository: Pick<AiEmployeesRepository, 'findById'>;
  readonly agentKeys: Pick<AgentKeysService, 'list'>;
  readonly aiConnectors: Pick<AiConnectorsService, 'list' | 'revoke'>;
  readonly names?: typeof memberDisplayNames;
  readonly enabled: boolean;
  readonly now?: () => Date;
}

function notFound(cause: string): ApiError {
  return new ApiError(404, 'not_found', 'Not found.', undefined, cause);
}

export class AiEmployeeConnectionsService {
  private readonly now: () => Date;

  constructor(private readonly options: AiEmployeeConnectionsServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** Live keys and live connectors, newest first. */
  async list(
    context: TenantContext,
    principal: Principal,
    id: string,
  ): Promise<AiEmployeeConnectionListView> {
    this.requireEnabled();
    requirePersonSession(context, principal);
    const at = this.now();
    return this.options.database.read(context, async (db) => {
      const row = await this.find(db, context, id);
      requireMayBind(context, row);
      const keys = (await this.options.agentKeys.list(db, context, row, at)).filter(
        (key) => key.live,
      );
      const connectors = await this.options.aiConnectors.list(db, context, row.membershipId);
      const names = await (this.options.names ?? memberDisplayNames)(
        db,
        context,
        keys.flatMap((key) =>
          key.createdByMembershipId === null ? [] : [key.createdByMembershipId],
        ),
      );
      const connections: AiEmployeeConnectionView[] = [
        ...connectors.map((connector) => ({
          id: connector.grantId,
          kind: 'connector' as const,
          name: connector.clientName,
          tokenPrefix: null,
          addedBy: {
            membershipId: connector.authorizedByMembershipId,
            displayName: connector.authorizedByName,
          },
          createdAt: connector.createdAt.toISOString(),
          lastUsedAt: connector.lastUsedAt?.toISOString() ?? null,
          expiresAt: null,
          live: true,
        })),
        ...keys.map((key) => ({
          id: key.id,
          kind: 'key' as const,
          name: key.name,
          tokenPrefix: key.tokenPrefix,
          addedBy: {
            membershipId: key.createdByMembershipId,
            displayName:
              key.createdByMembershipId === null
                ? null
                : (names.get(key.createdByMembershipId) ?? null),
          },
          createdAt: key.createdAt,
          lastUsedAt: key.lastUsedAt,
          expiresAt: key.expiresAt,
          live: true,
        })),
      ].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
      const live = connections.length;
      return {
        connections,
        limit: AI_EMPLOYEE_MAX_LIVE_CREDENTIALS,
        live,
        canCreate: row.status !== 'retired' && live < AI_EMPLOYEE_MAX_LIVE_CREDENTIALS,
      };
    });
  }

  /** Stop a connector now: the grant and all its tokens. Every status, retired included. */
  async revokeConnector(
    context: TenantContext,
    principal: Principal,
    id: string,
    grantId: string,
  ): Promise<void> {
    this.requireEnabled();
    requirePersonSession(context, principal);
    await this.options.database.transaction(context, async (tx) => {
      const row = await this.find(tx, context, id);
      requireMayBind(context, row);
      if (!(await this.options.aiConnectors.revoke(tx, context, row.membershipId, grantId))) {
        throw notFound('ai_employee:connector_not_found');
      }
      await this.options.audit.record(tx, context, {
        action: AI_CONNECTOR_AUDIT.revoked,
        result: 'allowed',
        objectId: row.id,
        actorUserId: context.userId,
        metadata: { grant_id: grantId },
      });
    });
  }

  private async find(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<AiEmployeeRecord> {
    const row = await this.options.repository.findById(runner, context, id.toLowerCase());
    if (row === null) throw notFound('ai_employee:not_found');
    return row;
  }

  private requireEnabled(): void {
    if (!this.options.enabled) throw aiEmployeesOff();
  }
}
