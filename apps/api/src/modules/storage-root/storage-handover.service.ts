import { authorize, hasCapability, isRole, isUuid } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { StorageConnectionRow } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import {
  StorageHandoverRepository,
  type HandoverCandidateRow,
  type StorageProvider,
} from './storage-handover.repository.js';

/**
 * 51-17. Hand the company storage connection to another admin.
 *
 * When the admin who connected Google Drive or OneDrive leaves, an owner or org admin
 * (`org.security.manage`) names another admin here. Nothing about the connection changes yet:
 * the named admin then connects the same provider from the Storage screen with their own account,
 * and that consent — bound to their own session by the existing flow cookie — swaps the token
 * while the root stays (`completeHandover` in the provider services). The target must be an
 * active member of this tenant whose role, read on the server, holds `org.security.manage` and
 * `org.manage`; nothing about the target is taken from the request but its id.
 */

export interface StorageHandoverTargetView {
  readonly userId: string;
  readonly displayName: string;
}

/** The hand-over picker's list. An envelope around the paired projection. */
export type StorageHandoverTargetList = {
  readonly targets: readonly StorageHandoverTargetView[];
};

export interface StorageHandoverView {
  readonly provider: StorageProvider;
  readonly toUserId: string;
  readonly toDisplayName: string;
  readonly status: 'pending';
}

export interface StorageHandoverStore {
  findConnection(
    runner: TenantQueryRunner,
    context: TenantContext,
    provider: StorageProvider,
  ): Promise<StorageConnectionRow | undefined>;
  listActiveMembers(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly HandoverCandidateRow[]>;
  findActiveMember(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId: string,
  ): Promise<HandoverCandidateRow | null>;
  setHandoverTarget(
    runner: TenantQueryRunner,
    context: TenantContext,
    connectionId: string,
    toUserId: string,
  ): Promise<void>;
}

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The request body is invalid', [
    { field, message },
  ]);
}

export function parseProvider(value: unknown): StorageProvider {
  if (value === 'google_drive' || value === 'onedrive') return value;
  throw invalid('provider', 'must be google_drive or onedrive');
}

/** Whether a stored role may hold the company storage connection. Custom roles never do. */
export function canHoldStorage(role: string): boolean {
  return (
    isRole(role) && hasCapability(role, 'org.security.manage') && hasCapability(role, 'org.manage')
  );
}

export class StorageHandoverService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly audit: Pick<AuditService, 'record'>,
    private readonly store: StorageHandoverStore = new StorageHandoverRepository(),
  ) {}

  /** Admins who could take the connection over: everyone eligible except its current holder. */
  async targets(
    context: TenantContext,
    principal: Principal,
    provider: StorageProvider,
  ): Promise<StorageHandoverTargetList> {
    this.requireSecurityManage(context, principal);
    const { connection, members } = await this.database.read(context, async (runner) => ({
      connection: await this.store.findConnection(runner, context, provider),
      members: await this.store.listActiveMembers(runner, context),
    }));
    const holder = live(connection)?.connectedByUserId ?? null;
    return {
      targets: members
        .filter((member) => member.userId !== holder && canHoldStorage(member.role))
        .map((member) => ({ userId: member.userId, displayName: member.displayName })),
    };
  }

  async request(
    context: TenantContext,
    principal: Principal,
    body: unknown,
  ): Promise<StorageHandoverView> {
    this.requireSecurityManage(context, principal);
    const input = body as { readonly provider?: unknown; readonly toUserId?: unknown } | null;
    const provider = parseProvider(input?.provider);
    const toUserId = input?.toUserId;
    if (typeof toUserId !== 'string' || !isUuid(toUserId)) {
      throw invalid('toUserId', 'must be a user id');
    }
    return this.database.transaction(context, async (tx) => {
      const connection = live(await this.store.findConnection(tx, context, provider));
      if (!connection) {
        throw new ApiError(409, 'conflict', 'This storage is not connected', [
          { field: 'storage', message: 'not_connected' },
        ]);
      }
      // A member of another tenant does not resolve here: the same answer as an unknown id.
      const target = await this.store.findActiveMember(tx, context, toUserId);
      if (!target || !canHoldStorage(target.role)) {
        throw invalid('toUserId', 'must be an admin of this workspace');
      }
      if (target.userId === connection.connectedByUserId) {
        throw invalid('toUserId', 'already holds the connection');
      }
      await this.store.setHandoverTarget(tx, context, connection.id, target.userId);
      await this.audit.record(tx, context, {
        action: 'storage_connection.handover_requested',
        result: 'allowed',
        objectId: connection.id,
        metadata: {
          provider,
          from_user_id: connection.connectedByUserId,
          to_user_id: target.userId,
        },
        changes: [
          {
            field: 'handover_to_user_id',
            before: connection.handoverToUserId,
            after: target.userId,
          },
        ],
      });
      return {
        provider,
        toUserId: target.userId,
        toDisplayName: target.displayName,
        status: 'pending' as const,
      };
    });
  }

  private requireSecurityManage(context: TenantContext, principal: Principal): void {
    const verdict = authorize({
      principal,
      capability: 'org.security.manage',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, verdict.code);
    }
  }
}

function live(row: StorageConnectionRow | undefined): StorageConnectionRow | undefined {
  return row && row.status !== 'disconnected' && row.refreshTokenEnc ? row : undefined;
}
