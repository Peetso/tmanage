import {
  assertSafeAuditMetadata,
  auditObjectTypeFor,
  outboxAggregateTypeFor,
  uuidv7,
} from '@tmanage/domain';
import type {
  AuditAction,
  AuditMetadata,
  OutboxEventPayloads,
  OutboxEventType,
} from '@tmanage/domain';
import type { WorkerTransaction } from './worker-database.js';

/**
 * The statements the lifecycle consumer needs — every one of them scoped to the
 * organization the triggering event carries. The claim was the unscoped step; from here
 * on, the relay behaves like any other writer: `organization_id` in every predicate, the
 * audit metadata gate at the write, the outbox aggregate type derived rather than chosen.
 */

export interface LinkedClientRequest {
  readonly id: string;
  readonly projectId: string;
  readonly clientOrganizationId: string;
  readonly state: string;
  readonly version: number;
}

/**
 * The request a work item is the committed answer to, locked for this transaction.
 *
 * `FOR UPDATE`: the consumer read-decides-writes, and a concurrent API transition on the
 * same request must wait rather than interleave. `linked_work_item_id` carries no index —
 * the table is small and the column was never queried before this consumer existed; noted
 * in implementation-status rather than silently indexed here, because indexes are the
 * migrator's to add.
 */
export async function findRequestLinkedToWorkItem(
  tx: WorkerTransaction,
  organizationId: string,
  workItemId: string,
): Promise<LinkedClientRequest | null> {
  interface Row {
    readonly id: string;
    readonly project_id: string;
    readonly client_organization_id: string;
    readonly state: string;
    readonly version: number;
  }
  const rows = await tx.query<readonly Row[]>(
    `SELECT id, project_id, client_organization_id, state, version
       FROM client_requests
      WHERE organization_id = ? AND linked_work_item_id = ?
      LIMIT 1
      FOR UPDATE`,
    [organizationId, workItemId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    clientOrganizationId: row.client_organization_id,
    state: row.state,
    version: Number(row.version),
  };
}

/**
 * Move a request `from` one state `to` the next, guarded by the state it was read in.
 *
 * The `AND state = ?` is the consumer's optimistic lock: zero rows affected means someone
 * moved the request between the locked read and this write — impossible inside one
 * transaction with `FOR UPDATE`, but cheap to keep true by construction rather than by
 * argument. Returns the new version, read back rather than computed.
 */
export async function transitionLinkedRequest(
  tx: WorkerTransaction,
  organizationId: string,
  requestId: string,
  from: string,
  to: string,
): Promise<number | null> {
  const result = await tx.query<{ affectedRows: number }>(
    `UPDATE client_requests
        SET state = ?, version = version + 1, updated_at = NOW(3)
      WHERE organization_id = ? AND id = ? AND state = ?`,
    [to, organizationId, requestId, from],
  );
  if (result.affectedRows === 0) return null;

  const rows = await tx.query<readonly { version: number }[]>(
    `SELECT version FROM client_requests WHERE organization_id = ? AND id = ?`,
    [organizationId, requestId],
  );
  return rows[0] ? Number(rows[0].version) : null;
}

export interface SystemAuditEventInput {
  readonly organizationId: string;
  readonly action: AuditAction;
  readonly objectId: string;
  /** The chain back to the request that caused the triggering event. Never invented. */
  readonly correlationId: string;
  readonly metadata: AuditMetadata;
}

/**
 * The audit row for a system-initiated change. `actor_user_id` is NULL — the column is
 * nullable for exactly this case, `AppendAuditEventInput` documents it ("an expiry job has
 * no actor"), and inventing a synthetic user id would poison every per-actor audit query.
 * The metadata gate and the derived object type are the same two rules the API's
 * repository applies, applied at this second write boundary for the reason that repository
 * gives: §12 holds only if it holds at every door.
 */
export async function insertSystemAuditEvent(
  tx: WorkerTransaction,
  input: SystemAuditEventInput,
): Promise<string> {
  assertSafeAuditMetadata(input.metadata);
  const id = uuidv7();
  await tx.query(
    `INSERT INTO audit_events
       (id, organization_id, actor_user_id, effective_actor_id, action, object_type,
        object_id, result, correlation_id, metadata_json, created_at)
     VALUES (?, ?, NULL, NULL, ?, ?, ?, 'allowed', ?, ?, NOW(3))`,
    [
      id,
      input.organizationId,
      input.action,
      auditObjectTypeFor(input.action),
      input.objectId,
      input.correlationId,
      JSON.stringify(input.metadata),
    ],
  );
  return id;
}

export interface WorkerOutboxEventInput<T extends OutboxEventType> {
  readonly organizationId: string;
  readonly type: T;
  readonly aggregateId: string;
  readonly payload: OutboxEventPayloads[T];
  readonly correlationId: string | null;
}

/**
 * A consumer's own outbox event — the relay is a producer too. The lifecycle rule's
 * transition must be announced exactly as an API-made one is, or a downstream consumer
 * would see every transition except the automatic ones.
 */
export async function insertWorkerOutboxEvent<T extends OutboxEventType>(
  tx: WorkerTransaction,
  input: WorkerOutboxEventInput<T>,
): Promise<string> {
  const id = uuidv7();
  await tx.query(
    `INSERT INTO outbox_events
       (id, organization_id, type, schema_version, aggregate_type, aggregate_id,
        payload_json, correlation_id, occurred_at, available_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, NOW(3), NOW(3))`,
    [
      id,
      input.organizationId,
      input.type,
      outboxAggregateTypeFor(input.type),
      input.aggregateId,
      JSON.stringify(input.payload),
      input.correlationId,
    ],
  );
  return id;
}
