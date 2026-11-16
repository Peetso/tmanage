import type { WorkerDatabase } from './worker-database.js';
import { insertWorkerOutboxEvent } from './lifecycle-store.js';
import {
  MAX_STORAGE_ROOT_CHECKS_PER_RUN,
  type StorageRootCandidate,
  type StorageRootCheckStore,
} from '../../jobs/storage-root-check.js';

/**
 * 51-17 slice 2 — the weekly storage-root check's statements, over the worker's own pool.
 *
 * One bounded read lists every live connection (a token held, not disconnected) with its root
 * owner kind and the connecting person's membership in the same workspace, skipping any
 * connection that already had a `storage_connection.root_at_risk.v1` event in the window
 * (`ix_outbox_events_org_aggregate`). The write is that event, through the relay's own producer
 * path. Grants: SELECT on `storage_connections` and `memberships`, SELECT and INSERT on
 * `outbox_events` — all held by the worker already.
 */

const AT_RISK_TYPE = 'storage_connection.root_at_risk.v1';

export interface StorageRootRow {
  readonly id: string;
  readonly organization_id: string;
  readonly provider: string;
  readonly root_owner_kind: string;
  readonly holder_role: string | null;
  readonly holder_status: string | null;
}

/** A row as the job reads it; a provider other than the two cloud drives is not a candidate. */
export function storageRootCandidateOf(row: StorageRootRow): StorageRootCandidate | null {
  if (row.provider !== 'google_drive' && row.provider !== 'onedrive') return null;
  return {
    organizationId: row.organization_id,
    connectionId: row.id,
    provider: row.provider,
    rootOwnerKind: row.root_owner_kind,
    holder:
      row.holder_role === null || row.holder_status === null
        ? null
        : { role: row.holder_role, status: row.holder_status },
  };
}

export function createStorageRootCheckStore(database: WorkerDatabase): StorageRootCheckStore {
  return {
    listCandidates: (since) =>
      database.read(async (tx) => {
        const rows = await tx.query<readonly StorageRootRow[]>(
          `SELECT s.id, s.organization_id, s.provider, s.root_owner_kind,
                  m.role AS holder_role, m.status AS holder_status
             FROM storage_connections s
             LEFT JOIN memberships m
               ON m.organization_id = s.organization_id
              AND m.user_id = s.connected_by_user_id
            WHERE s.status <> 'disconnected'
              AND s.refresh_token_enc IS NOT NULL
              AND NOT EXISTS (
                    SELECT 1 FROM outbox_events e
                     WHERE e.organization_id = s.organization_id
                       AND e.aggregate_type = 'storage_connection'
                       AND e.aggregate_id = s.id
                       AND e.type = ?
                       AND e.occurred_at >= ?)
            ORDER BY s.organization_id, s.id
            LIMIT ?`,
          [AT_RISK_TYPE, since, MAX_STORAGE_ROOT_CHECKS_PER_RUN],
        );
        return rows.flatMap((row) => {
          const candidate = storageRootCandidateOf(row);
          return candidate === null ? [] : [candidate];
        });
      }),
    announce: (payload) =>
      database.transaction(async (tx) => {
        await insertWorkerOutboxEvent(tx, {
          organizationId: payload.organizationId,
          type: AT_RISK_TYPE,
          aggregateId: payload.connectionId,
          payload,
          correlationId: null,
        });
      }),
  };
}
