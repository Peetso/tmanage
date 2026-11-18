import { uuidv7, type ActivitySource } from '@tmanage/domain';
import type { WorkerDatabase, WorkerTransaction } from './worker-database.js';
import type {
  ActivityAuditEvent,
  ActivityCursor,
  ActivityEntryRecord,
  ActivityOrganization,
  ActivityPlacement,
  ActivityProjectorStore,
} from '../../jobs/activity-projector.js';

/**
 * 62-A2 (B02): the activity projector's statements over the worker's pool (0379).
 *
 * Grants (scripts/db/users.sql, 0379 block — committer wiring): SELECT, INSERT on
 * `activity_entries`; SELECT, INSERT, UPDATE on `activity_projection_cursors`; SELECT on
 * `audit_events`, `organizations`, `projects`, `work_items`, `work_item_time_logs`, `file_assets`,
 * `deliverables`, `approvals`, `project_milestones`, `client_requests`, `client_invoices`, `quotes`,
 * `expenses`. Every statement on a tenant table names the organization it is about; every value is
 * bound. Only ids, actions, results, timestamps and audience flags are selected — never a title,
 * a body or other metadata.
 *
 * {@link PLACEMENT_SQL} is the one place an object is resolved to its project and client: one
 * statement per catalogued source, each returning `project_id`, `client_organization_id` and
 * `audience` ('internal' | 'client_visible'). A deleted row returns nothing.
 */

type Rows = readonly Record<string, unknown>[];

interface WriteResult {
  readonly affectedRows: number;
}

/** Per source: `[organizationId, objectId]` → at most one placement row. */
export const PLACEMENT_SQL: Readonly<Record<ActivitySource, string>> = {
  project: `SELECT p.id AS project_id, NULL AS client_organization_id, 'internal' AS audience
      FROM projects p WHERE p.organization_id = ? AND p.id = ?`,
  // A revoked membership's row is deleted: the project comes from the audit row's metadata
  // (written by the membership service), checked against `projects` in the same organization.
  project_membership: `SELECT p.id AS project_id, NULL AS client_organization_id,
        'internal' AS audience
      FROM projects p WHERE p.organization_id = ? AND p.id = ?`,
  work_item: `SELECT w.project_id AS project_id, NULL AS client_organization_id,
        CASE WHEN w.audience = 'internal' THEN 'internal' ELSE 'client_visible' END AS audience
      FROM work_items w WHERE w.organization_id = ? AND w.id = ? AND w.deleted_at IS NULL`,
  time_log: `SELECT COALESCE(t.project_id, w.project_id) AS project_id,
        NULL AS client_organization_id, 'internal' AS audience
      FROM work_item_time_logs t
      JOIN work_items w ON w.organization_id = t.organization_id AND w.id = t.work_item_id
     WHERE t.organization_id = ? AND t.id = ?`,
  file_asset: `SELECT f.project_id AS project_id, f.client_organization_id AS client_organization_id,
        CASE WHEN f.audience = 'internal' THEN 'internal' ELSE 'client_visible' END AS audience
      FROM file_assets f WHERE f.organization_id = ? AND f.id = ? AND f.deleted_at IS NULL`,
  deliverable: `SELECT d.project_id AS project_id, NULL AS client_organization_id,
        'internal' AS audience
      FROM deliverables d WHERE d.organization_id = ? AND d.id = ? AND d.deleted_at IS NULL`,
  approval: `SELECT a.project_id AS project_id, NULL AS client_organization_id,
        'client_visible' AS audience
      FROM approvals a WHERE a.organization_id = ? AND a.id = ?`,
  project_milestone: `SELECT m.project_id AS project_id, NULL AS client_organization_id,
        CASE WHEN m.published = 1 THEN 'client_visible' ELSE 'internal' END AS audience
      FROM project_milestones m WHERE m.organization_id = ? AND m.id = ?`,
  client_request: `SELECT r.project_id AS project_id,
        r.client_organization_id AS client_organization_id, 'client_visible' AS audience
      FROM client_requests r WHERE r.organization_id = ? AND r.id = ?`,
  client_invoice: `SELECT i.project_id AS project_id,
        i.client_organization_id AS client_organization_id, 'internal' AS audience
      FROM client_invoices i WHERE i.organization_id = ? AND i.id = ?`,
  quote: `SELECT q.converted_project_id AS project_id,
        q.client_organization_id AS client_organization_id, 'internal' AS audience
      FROM quotes q WHERE q.organization_id = ? AND q.id = ?`,
  expense: `SELECT e.project_id AS project_id,
        e.client_organization_id AS client_organization_id, 'internal' AS audience
      FROM expenses e WHERE e.organization_id = ? AND e.id = ?`,
};

const EVENT_COLUMNS = `e.id AS id, e.action AS action, e.object_id AS object_id,
       e.actor_user_id AS actor_user_id, e.result AS result, e.created_at AS created_at,
       json_unquote(json_extract(e.metadata_json, '$.project_id')) AS metadata_project_id`;

export const ACTIVITY_PROJECTOR_SQL = {
  organizations: `SELECT o.id AS organization_id, c.last_created_at AS last_created_at,
         c.last_event_id AS last_event_id
    FROM organizations o
    LEFT JOIN activity_projection_cursors c ON c.organization_id = o.id
   WHERE o.deleted_at IS NULL
   ORDER BY c.updated_at IS NOT NULL, c.updated_at, o.id
   LIMIT ?`,
  eventsFromStart: `SELECT ${EVENT_COLUMNS}
    FROM audit_events e
   WHERE e.organization_id = ? AND e.created_at < ?
   ORDER BY e.created_at, e.id
   LIMIT ?`,
  eventsAfter: `SELECT ${EVENT_COLUMNS}
    FROM audit_events e
   WHERE e.organization_id = ? AND e.created_at < ?
     AND (e.created_at > ? OR (e.created_at = ? AND e.id > ?))
   ORDER BY e.created_at, e.id
   LIMIT ?`,
  insertEntry: `INSERT IGNORE INTO activity_entries
     (id, organization_id, project_id, client_organization_id, object_type, object_id, action,
      kind, actor_user_id, audience_class, occurred_at, source_audit_id, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  moveCursor: `INSERT INTO activity_projection_cursors
     (id, organization_id, last_created_at, last_event_id, updated_at)
   VALUES (?, ?, ?, ?, ?)
   ON DUPLICATE KEY UPDATE last_created_at = VALUES(last_created_at),
     last_event_id = VALUES(last_event_id), updated_at = VALUES(updated_at)`,
  touchCursor: `INSERT INTO activity_projection_cursors
     (id, organization_id, last_created_at, last_event_id, updated_at)
   VALUES (?, ?, NULL, NULL, ?)
   ON DUPLICATE KEY UPDATE updated_at = VALUES(updated_at)`,
} as const;

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const date = (value: unknown): Date => (value instanceof Date ? value : new Date(String(value)));

function toEvent(row: Record<string, unknown>): ActivityAuditEvent {
  return {
    id: String(row['id']),
    action: String(row['action']),
    objectId: str(row['object_id']),
    actorUserId: str(row['actor_user_id']),
    result: String(row['result']),
    createdAt: date(row['created_at']),
    metadataProjectId: str(row['metadata_project_id']),
  };
}

function toPlacement(row: Record<string, unknown>): ActivityPlacement {
  return {
    projectId: str(row['project_id']),
    clientOrganizationId: str(row['client_organization_id']),
    audience: row['audience'] === 'client_visible' ? 'client_visible' : 'internal',
  };
}

async function insertEntries(
  tx: WorkerTransaction,
  entries: readonly ActivityEntryRecord[],
  at: Date,
): Promise<number> {
  let written = 0;
  for (const entry of entries) {
    const result = await tx.query<WriteResult>(ACTIVITY_PROJECTOR_SQL.insertEntry, [
      uuidv7(),
      entry.organizationId,
      entry.projectId,
      entry.clientOrganizationId,
      entry.objectType,
      entry.objectId,
      entry.action,
      entry.kind,
      entry.actorUserId,
      entry.audienceClass,
      entry.occurredAt,
      entry.sourceAuditId,
      at,
    ]);
    written += result.affectedRows;
  }
  return written;
}

export function createActivityProjectorStore(database: WorkerDatabase): ActivityProjectorStore {
  return {
    organizations: (limit) =>
      database.read(async (tx) => {
        const rows = await tx.query<Rows>(ACTIVITY_PROJECTOR_SQL.organizations, [limit]);
        return rows.map((row): ActivityOrganization => {
          const eventId = str(row['last_event_id']);
          const createdAt = row['last_created_at'];
          return {
            organizationId: String(row['organization_id']),
            cursor:
              eventId === null || createdAt === null || createdAt === undefined
                ? null
                : { createdAt: date(createdAt), eventId },
          };
        });
      }),
    eventsAfter: (organizationId, cursor: ActivityCursor | null, settledBefore, limit) =>
      database.read(async (tx) => {
        const rows =
          cursor === null
            ? await tx.query<Rows>(ACTIVITY_PROJECTOR_SQL.eventsFromStart, [
                organizationId,
                settledBefore,
                limit,
              ])
            : await tx.query<Rows>(ACTIVITY_PROJECTOR_SQL.eventsAfter, [
                organizationId,
                settledBefore,
                cursor.createdAt,
                cursor.createdAt,
                cursor.eventId,
                limit,
              ]);
        return rows.map(toEvent);
      }),
    place: (organizationId, source, event) => {
      const key = source === 'project_membership' ? event.metadataProjectId : event.objectId;
      if (key === null) return Promise.resolve(null);
      return database.read(async (tx) => {
        const rows = await tx.query<Rows>(PLACEMENT_SQL[source], [organizationId, key]);
        const row = rows[0];
        return row === undefined ? null : toPlacement(row);
      });
    },
    fileBatch: (organizationId, entries, cursor, at) =>
      database.transaction(async (tx) => {
        const written = await insertEntries(tx, entries, at);
        if (cursor === null) {
          await tx.query(ACTIVITY_PROJECTOR_SQL.touchCursor, [uuidv7(), organizationId, at]);
        } else {
          await tx.query(ACTIVITY_PROJECTOR_SQL.moveCursor, [
            uuidv7(),
            organizationId,
            cursor.createdAt,
            cursor.eventId,
            at,
          ]);
        }
        return written;
      }),
  };
}
