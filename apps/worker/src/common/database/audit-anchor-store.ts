import { uuidv7 } from '@tmanage/domain';
import type { WorkerDatabase } from './worker-database.js';
import type {
  AnchorRecord,
  AuditAnchorStore,
  AuditHeadSnapshot,
  PlatformAnchorRecord,
} from '../../jobs/audit-anchor.js';

/**
 * 56-11: the audit chain jobs' statements, over the worker's pool. `tmanage_worker` holds SELECT
 * on `organizations`, `audit_events`, `audit_heads`, `audit_anchors`, `platform_audit_anchors`,
 * INSERT on `audit_heads` (chain start only — never UPDATE: the head belongs to the API writer),
 * and INSERT on both anchor tables (scripts/db/users.sql, 56-11 block). Every statement on a
 * tenant table names the organization it is about.
 */

interface WriteResult {
  readonly affectedRows: number;
}

const ORGS_WITHOUT_HEAD = `SELECT o.id AS id
  FROM organizations o
  LEFT JOIN audit_heads h ON h.organization_id = o.id
 WHERE h.id IS NULL
 ORDER BY o.id
 LIMIT ?`;

const MARK_CHAIN_START = `INSERT IGNORE INTO audit_heads
   (id, organization_id, chain_seq, head_hash, last_event_id, legacy_last_event_id,
    chain_started_at, updated_at)
 SELECT ?, ?, 0, ?, NULL,
        (SELECT max(e.id) FROM audit_events e WHERE e.organization_id = ?),
        current_timestamp(3), current_timestamp(3)`;

const HEADS = `SELECT organization_id, chain_seq, head_hash FROM audit_heads ORDER BY organization_id`;

const INSERT_ANCHOR = `INSERT IGNORE INTO audit_anchors
   (id, organization_id, day, head_hash, event_count, signature, created_at)
 VALUES (?, ?, ?, ?, ?, ?, current_timestamp(3))`;

const ANCHORS_FOR_DAY = `SELECT organization_id, date_format(day, '%Y-%m-%d') AS day, head_hash,
       event_count, signature
  FROM audit_anchors
 WHERE day = ?
 ORDER BY organization_id`;

const INSERT_PLATFORM_ANCHOR = `INSERT IGNORE INTO platform_audit_anchors
   (id, day, root_hash, org_count, signature, created_at)
 VALUES (?, ?, ?, ?, ?, current_timestamp(3))`;

interface HeadRow {
  readonly organization_id: string;
  readonly chain_seq: number | string;
  readonly head_hash: string;
}

interface AnchorRow {
  readonly organization_id: string;
  readonly head_hash: string;
  readonly day: string;
  readonly event_count: number | string;
  readonly signature: string | null;
}

export function createAuditAnchorStore(database: WorkerDatabase): AuditAnchorStore {
  return {
    organizationsWithoutHead: (limit) =>
      database.read(async (tx) => {
        const rows = await tx.query<readonly { id: string }[]>(ORGS_WITHOUT_HEAD, [limit]);
        return rows.map((row) => row.id);
      }),
    markChainStart: (organizationId, genesis) =>
      database.transaction(async (tx) => {
        await tx.query(MARK_CHAIN_START, [uuidv7(), organizationId, genesis, organizationId]);
      }),
    heads: () =>
      database.read(async (tx) => {
        const rows = await tx.query<readonly HeadRow[]>(HEADS);
        return rows.map((row): AuditHeadSnapshot => ({
          organizationId: row.organization_id,
          chainSeq: Number(row.chain_seq),
          headHash: row.head_hash,
        }));
      }),
    insertAnchor: (anchor) =>
      database.transaction(async (tx) => {
        const result = await tx.query<WriteResult>(INSERT_ANCHOR, [
          uuidv7(),
          anchor.organizationId,
          anchor.day,
          anchor.headHash,
          anchor.eventCount,
          anchor.signature,
        ]);
        return result.affectedRows > 0;
      }),
    anchorsForDay: (day) =>
      database.read(async (tx) => {
        const rows = await tx.query<readonly AnchorRow[]>(ANCHORS_FOR_DAY, [day]);
        return rows.map((row): AnchorRecord => ({
          organizationId: row.organization_id,
          day: row.day,
          headHash: row.head_hash,
          eventCount: Number(row.event_count),
          signature: row.signature,
        }));
      }),
    insertPlatformAnchor: (anchor: PlatformAnchorRecord) =>
      database.transaction(async (tx) => {
        const result = await tx.query<WriteResult>(INSERT_PLATFORM_ANCHOR, [
          uuidv7(),
          anchor.day,
          anchor.rootHash,
          anchor.orgCount,
          anchor.signature,
        ]);
        return result.affectedRows > 0;
      }),
  };
}
