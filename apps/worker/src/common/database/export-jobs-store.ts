import type { WorkerDatabase, WorkerTransaction } from './worker-database.js';
import { WORKER_EXPORT_SCOPES } from '../../jobs/export-jobs.js';
import type {
  ClaimedExportJob,
  ExportJobStore,
  ExportTable,
  RemovableExport,
  WorkerExportScope,
} from '../../jobs/export-jobs.js';

/**
 * platform-admin v2 · PA-09: the export job's statements, over the worker's pool.
 *
 * `tmanage_worker` holds SELECT/UPDATE on `platform_export_jobs` and SELECT on `audit_events`,
 * `sessions`, `platform_admin_audit_events`, `organizations`, `users` and `memberships`
 * (scripts/db/users.sql). The action log export reads metadata columns only — never
 * `metadata_json` and never `audit_event_changes`; the sessions export never reads a token hash.
 * Each scope's filter keys are the API's `EXPORT_FILTER_KEYS` (`activity/exports.ts`).
 */

type Param = string | number | Date;
type Row = Record<string, unknown>;
interface WriteResult {
  readonly affectedRows: number;
}

const CLAIM = `SELECT id, scope, filter_json FROM platform_export_jobs
 WHERE status = 'queued' AND scope <> 'sign-ins'
 ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`;
const MARK_RUNNING = `UPDATE platform_export_jobs SET status = 'running'
 WHERE id = ? AND status = 'queued'`;
const FINISH_READY = `UPDATE platform_export_jobs
   SET status = 'ready', row_count = ?, object_key = ?, error = NULL,
       finished_at = current_timestamp(3),
       expires_at = current_timestamp(3) + interval 24 hour
 WHERE id = ? AND status = 'running'`;
const FINISH_FAILED = `UPDATE platform_export_jobs
   SET status = 'failed', error = ?, finished_at = current_timestamp(3)
 WHERE id = ? AND status = 'running'`;
const FAIL_STALE = `UPDATE platform_export_jobs
   SET status = 'failed', error = 'The export took too long. Run it again.',
       finished_at = current_timestamp(3)
 WHERE status = 'running' AND created_at < current_timestamp(3) - interval ? second`;
const LIST_REMOVABLE = `SELECT id, object_key, status FROM platform_export_jobs
 WHERE object_key IS NOT NULL
   AND (status IN ('deleted', 'failed', 'expired')
        OR (status = 'ready' AND expires_at <= current_timestamp(3)))
 ORDER BY created_at, id LIMIT ?`;
const MARK_EXPIRED = `UPDATE platform_export_jobs SET status = 'expired', object_key = NULL
 WHERE id = ? AND object_key = ? AND status = 'ready'`;
const DROP_KEY = `UPDATE platform_export_jobs SET object_key = NULL
 WHERE id = ? AND object_key = ?`;

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return JSON.stringify(value);
}

function date(value: string | undefined): Date | null {
  if (value === undefined || value === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/gu, '')}%`;
}

interface Where {
  readonly sql: string;
  readonly params: Param[];
}

function where(build: (add: (fragment: string, ...values: Param[]) => void) => void): Where {
  const sql: string[] = [];
  const params: Param[] = [];
  build((fragment, ...values) => {
    sql.push(fragment);
    params.push(...values);
  });
  return { sql: sql.length === 0 ? '' : `WHERE ${sql.join(' AND ')}`, params };
}

interface ScopeQuery {
  readonly header: readonly string[];
  readonly columns: readonly string[];
  build(filter: Readonly<Record<string, string>>): {
    sql: (limit: string) => string;
    params: Param[];
  };
}

const ACTIONS_SQL = (clause: string, limit: string) => `SELECT e.created_at AS created_at,
       e.organization_id AS organization_id, o.name AS organization_name,
       ua.email AS actor_email, ue.email AS effective_actor_email, e.action AS action,
       e.object_type AS object_type, e.object_id AS object_id, e.result AS result,
       e.platform_support_session_id AS support_session_id, e.ip AS ip,
       e.correlation_id AS correlation_id, e.id AS id
  FROM audit_events e
  JOIN organizations o ON o.id = e.organization_id
  LEFT JOIN users ua ON ua.id = e.actor_user_id
  LEFT JOIN users ue ON ue.id = e.effective_actor_id
  ${clause}
 ORDER BY e.created_at DESC, e.id DESC LIMIT ${limit}`;

const SESSIONS_SQL = (clause: string, limit: string) => `SELECT s.created_at AS created_at,
       u.email AS email, u.display_name AS display_name, s.user_agent AS user_agent,
       s.ip_first AS ip_first, s.ip_last AS ip_last,
       coalesce(s.rotated_at, s.created_at) AS last_active_at, s.expires_at AS expires_at,
       s.revoked_at AS revoked_at, s.id AS id
  FROM sessions s JOIN users u ON u.id = s.user_id
  ${clause}
 ORDER BY s.created_at DESC, s.id DESC LIMIT ${limit}`;

const PLATFORM_SQL = (clause: string, limit: string) => `SELECT p.created_at AS created_at,
       p.actor_email AS actor_email, p.action AS action, p.target_type AS target_type,
       p.target_id AS target_id, p.target_label AS target_label,
       p.organization_id AS organization_id, p.reason AS reason,
       p.support_session_id AS support_session_id, p.ip AS ip,
       p.correlation_id AS correlation_id, p.id AS id
  FROM platform_admin_audit_events p
  ${clause}
 ORDER BY p.created_at DESC, p.id DESC LIMIT ${limit}`;

const ORGS_SQL = (clause: string, limit: string) => `SELECT o.id AS id, o.name AS name,
       o.slug AS slug, o.created_at AS created_at, o.suspended_at AS suspended_at,
       o.archived_at AS archived_at, o.deleted_at AS deleted_at,
       (SELECT count(*) FROM memberships m
         WHERE m.organization_id = o.id AND m.status = 'active') AS members
  FROM organizations o
  ${clause}
 ORDER BY o.created_at DESC, o.id DESC LIMIT ${limit}`;

const PEOPLE_SQL = (clause: string, limit: string) => `SELECT u.id AS id, u.email AS email,
       u.display_name AS display_name, u.created_at AS created_at,
       u.email_verified_at AS email_verified_at, u.disabled_at AS disabled_at,
       (SELECT count(*) FROM memberships m
         WHERE m.user_id = u.id AND m.status = 'active') AS organizations
  FROM users u
  ${clause}
 ORDER BY u.created_at DESC, u.id DESC LIMIT ${limit}`;

export const EXPORT_SCOPE_QUERIES: Readonly<Record<WorkerExportScope, ScopeQuery>> = {
  actions: {
    header: [
      'Time (UTC)',
      'Organization ID',
      'Organization',
      'Actor',
      'Acting as',
      'Action',
      'Object type',
      'Object ID',
      'Result',
      'Support session',
      'IP',
      'Correlation ID',
      'Event ID',
    ],
    columns: [
      'created_at',
      'organization_id',
      'organization_name',
      'actor_email',
      'effective_actor_email',
      'action',
      'object_type',
      'object_id',
      'result',
      'support_session_id',
      'ip',
      'correlation_id',
      'id',
    ],
    build(f) {
      const w = where((add) => {
        if (f['organizationId']) add('e.organization_id = ?', f['organizationId']);
        if (f['actorUserId']) add('e.actor_user_id = ?', f['actorUserId']);
        if (f['effectiveActorUserId']) add('e.effective_actor_id = ?', f['effectiveActorUserId']);
        if (f['supportOnly'] === 'true') add('e.platform_support_session_id IS NOT NULL');
        if (f['supportSessionId']) add('e.platform_support_session_id = ?', f['supportSessionId']);
        if (f['action']) add('e.action = ?', f['action']);
        if (f['actionFamily']) {
          add('e.action LIKE ?', `${f['actionFamily'].replace(/[\\%_]/gu, '')}.%`);
        }
        if (f['objectType']) add('e.object_type = ?', f['objectType']);
        if (f['objectId']) add('e.object_id = ?', f['objectId']);
        if (f['result']) add('e.result = ?', f['result']);
        const from = date(f['from']);
        const to = date(f['to']);
        if (from) add('e.created_at >= ?', from);
        if (to) add('e.created_at < ?', to);
        if (f['ip']) add('e.ip = ?', f['ip']);
        if (f['correlationId']) add('e.correlation_id = ?', f['correlationId']);
      });
      return { sql: (limit) => ACTIONS_SQL(w.sql, limit), params: w.params };
    },
  },
  sessions: {
    header: [
      'Started (UTC)',
      'Email',
      'Name',
      'Device',
      'First IP',
      'Last IP',
      'Last active (UTC)',
      'Expires (UTC)',
      'Ended (UTC)',
      'Session ID',
    ],
    columns: [
      'created_at',
      'email',
      'display_name',
      'user_agent',
      'ip_first',
      'ip_last',
      'last_active_at',
      'expires_at',
      'revoked_at',
      'id',
    ],
    build(f) {
      const w = where((add) => {
        if (f['userId']) add('s.user_id = ?', f['userId']);
        if (f['active'] !== 'false') add('s.revoked_at IS NULL AND s.expires_at > now(3)');
        if (f['ip']) add('(s.ip_first = ? OR s.ip_last = ?)', f['ip'], f['ip']);
      });
      return { sql: (limit) => SESSIONS_SQL(w.sql, limit), params: w.params };
    },
  },
  platform: {
    header: [
      'Time (UTC)',
      'Admin',
      'Action',
      'Target type',
      'Target ID',
      'Target',
      'Organization ID',
      'Reason',
      'Support session',
      'IP',
      'Correlation ID',
      'Event ID',
    ],
    columns: [
      'created_at',
      'actor_email',
      'action',
      'target_type',
      'target_id',
      'target_label',
      'organization_id',
      'reason',
      'support_session_id',
      'ip',
      'correlation_id',
      'id',
    ],
    build(f) {
      const w = where((add) => {
        if (f['adminId']) add('p.actor_user_id = ?', f['adminId']);
        if (f['action']) add('p.action = ?', f['action']);
        if (f['organizationId']) add('p.organization_id = ?', f['organizationId']);
        const from = date(f['from']);
        const to = date(f['to']);
        if (from) add('p.created_at >= ?', from);
        if (to) add('p.created_at < ?', to);
      });
      return { sql: (limit) => PLATFORM_SQL(w.sql, limit), params: w.params };
    },
  },
  orgs: {
    header: [
      'Organization ID',
      'Name',
      'Slug',
      'Created (UTC)',
      'Suspended (UTC)',
      'Archived (UTC)',
      'Deleted (UTC)',
      'Active members',
    ],
    columns: [
      'id',
      'name',
      'slug',
      'created_at',
      'suspended_at',
      'archived_at',
      'deleted_at',
      'members',
    ],
    build(f) {
      const w = where((add) => {
        if (f['q'])
          add('(o.name LIKE ? OR o.slug LIKE ?)', likeContains(f['q']), likeContains(f['q']));
      });
      return { sql: (limit) => ORGS_SQL(w.sql, limit), params: w.params };
    },
  },
  people: {
    header: [
      'User ID',
      'Email',
      'Name',
      'Joined (UTC)',
      'Email verified (UTC)',
      'Disabled (UTC)',
      'Organizations',
    ],
    columns: [
      'id',
      'email',
      'display_name',
      'created_at',
      'email_verified_at',
      'disabled_at',
      'organizations',
    ],
    build(f) {
      const w = where((add) => {
        if (f['q']) {
          add(
            '(u.email LIKE ? OR u.display_name LIKE ?)',
            likeContains(f['q']),
            likeContains(f['q']),
          );
        }
      });
      return { sql: (limit) => PEOPLE_SQL(w.sql, limit), params: w.params };
    },
  },
};

function parseFilter(raw: unknown): Record<string, string> {
  if (typeof raw !== 'string' || raw === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export async function claimNextExport(tx: WorkerTransaction): Promise<ClaimedExportJob | null> {
  const rows = await tx.query<readonly Row[]>(CLAIM, []);
  return rows[0] ? claimNextFromRow(tx, rows[0]) : null;
}

export async function readExportRows(
  tx: WorkerTransaction,
  job: ClaimedExportJob,
  limit: number,
): Promise<ExportTable> {
  const query = EXPORT_SCOPE_QUERIES[job.scope];
  const built = query.build(job.filter);
  const rows = await tx.query<readonly Row[]>(built.sql('?'), [
    ...built.params,
    Math.max(1, Math.trunc(limit)),
  ]);
  return {
    header: query.header,
    rows: rows.map((row) => query.columns.map((column) => text(row[column]))),
  };
}

export function createExportJobStore(database: WorkerDatabase): ExportJobStore {
  return {
    async claimNext() {
      // A claim that names an unknown scope fails it and looks again, inside the batch's loop.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const outcome = await database.transaction(async (tx) => {
          const rows = await tx.query<readonly Row[]>(CLAIM, []);
          if (rows.length === 0) return { done: true as const, job: null };
          return { done: false as const, job: await claimNextFromRow(tx, rows[0] as Row) };
        });
        if (outcome.done || outcome.job) return outcome.job;
      }
      return null;
    },
    readRows: (job, limit) => database.read((tx) => readExportRows(tx, job, limit)),
    async finishReady(id, rowCount, objectKey) {
      const result = await database.transaction((tx) =>
        tx.query<WriteResult>(FINISH_READY, [rowCount, objectKey, id]),
      );
      return result.affectedRows > 0;
    },
    async finishFailed(id, error) {
      await database.transaction((tx) => tx.query(FINISH_FAILED, [error, id]));
    },
    listRemovable: (limit) =>
      database.read(async (tx) => {
        const rows = await tx.query<readonly Row[]>(LIST_REMOVABLE, [
          Math.max(1, Math.trunc(limit)),
        ]);
        return rows.map((row): RemovableExport => ({
          id: String(row['id']),
          objectKey: String(row['object_key']),
          kind: row['status'] === 'ready' ? 'expire' : 'drop',
        }));
      }),
    async markRemoved(file) {
      await database.transaction((tx) =>
        tx.query(file.kind === 'expire' ? MARK_EXPIRED : DROP_KEY, [file.id, file.objectKey]),
      );
    },
    async failStale(timeoutMs) {
      const result = await database.transaction((tx) =>
        tx.query<WriteResult>(FAIL_STALE, [Math.max(1, Math.trunc(timeoutMs / 1000))]),
      );
      return result.affectedRows;
    },
  };
}

async function claimNextFromRow(tx: WorkerTransaction, row: Row): Promise<ClaimedExportJob | null> {
  const id = String(row['id']);
  const scope = String(row['scope']);
  await tx.query(MARK_RUNNING, [id]);
  if (!(WORKER_EXPORT_SCOPES as readonly string[]).includes(scope)) {
    await tx.query(FINISH_FAILED, ['This export type is not known.', id]);
    return null;
  }
  return { id, scope: scope as WorkerExportScope, filter: parseFilter(row['filter_json']) };
}
