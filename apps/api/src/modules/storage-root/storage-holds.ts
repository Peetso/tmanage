import type { OutboxEventPayloads } from '@tmanage/domain';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import { StorageHandoverRepository, type StorageProvider } from './storage-handover.repository.js';

type RootAtRisk = OutboxEventPayloads['storage_connection.root_at_risk.v1'];

/** One live company storage connection a person holds (they connected it). */
export interface StorageHold {
  readonly connectionId: string;
  readonly provider: StorageProvider;
}

/**
 * 51-17 slice 2 — the offboarding hook. When a person leaves (offboard, SCIM deactivation), the
 * storage connections they hold keep working on their token only until their account is removed
 * at Google or Microsoft. This reads which live connections they hold, inside the leaving
 * transaction, and announces each one (`storage_connection.root_at_risk.v1`, reason
 * `holder_offboarded`): the worker tells the workspace owners in the inbox and by e-mail. Nothing
 * is disconnected here — files keep working until the hand-over.
 */
export class StorageHoldsHook {
  constructor(
    private readonly outbox: Pick<OutboxEventsRepository, 'append'> = new OutboxEventsRepository(),
    private readonly connections: Pick<
      StorageHandoverRepository,
      'listHeldBy'
    > = new StorageHandoverRepository(),
  ) {}

  async heldBy(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId: string,
  ): Promise<readonly StorageHold[]> {
    const rows = await this.connections.listHeldBy(runner, context, userId);
    return rows.flatMap((row) =>
      row.provider === 'google_drive' || row.provider === 'onedrive'
        ? [{ connectionId: row.id, provider: row.provider }]
        : [],
    );
  }

  /** Announce each hold as at risk because its holder left; `scopeId` makes the key unique. */
  async announceLeft(
    runner: TenantQueryRunner,
    context: TenantContext,
    holds: readonly StorageHold[],
    scopeId: string,
  ): Promise<void> {
    for (const hold of holds) {
      const payload: RootAtRisk = {
        organizationId: context.organizationId,
        connectionId: hold.connectionId,
        provider: hold.provider,
        reason: 'holder_offboarded',
        idempotencyKey: `${hold.connectionId}:holder_offboarded:${scopeId}`,
        occurredAt: new Date().toISOString(),
      };
      await this.outbox.append(runner, context, {
        type: 'storage_connection.root_at_risk.v1',
        aggregateId: hold.connectionId,
        payload,
      });
    }
  }
}
