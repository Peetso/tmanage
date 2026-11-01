import type { WorkerDatabase } from '../common/database/worker-database.js';
import { createContentPurgeStore } from '../common/database/content-purge-store.js';

/**
 * platform-admin v2 · PA-03 (0245, SPEC P7): the content purge.
 *
 * Deleting content in TManage is a soft delete: the row keeps its data, gains `deleted_at`,
 * `deleted_by_user_id`, `deleted_reason` and a `purge_after` (now + the platform's
 * `retention.content_purge_days`, 30 by default), and leaves every list read. Until
 * `purge_after` the platform operator can restore it. This job is the end of that window: every
 * row whose `purge_after` is at or before the database clock is removed for good.
 *
 * - **Bounded.** Each table gives up at most {@link PURGE_BATCH} rows per run; the next run takes
 *   the rest, so one run never holds a long lock.
 * - **Tenant-scoped.** Every DELETE names one `organization_id`; the row ids come from a read of
 *   that table, and the DELETE repeats `deleted_at IS NOT NULL AND purge_after <= now`, so a row
 *   restored between the read and the delete stays.
 * - **Idempotent.** A second run with nothing past its window deletes nothing.
 * - **Children first.** {@link CONTENT_PURGE_TABLES} lists child tables before their parents, so a
 *   comment purged with its document goes first. A row still referenced by a live row (MariaDB
 *   errno 1451) is skipped and counted as `blocked`; it is tried again on the next run.
 *
 * `file_assets` is not here on purpose: removing a file also removes its stored object, which is
 * the file purge path's job. `PURGE_HOOKS` is the seam for the rest — PA-07 plugs the
 * organization purge into it.
 */

/** The content tables, children before parents. Every one carries the 0245 columns and `id`. */
export const CONTENT_PURGE_TABLES: readonly string[] = Object.freeze([
  'message_attachments',
  'messages',
  'direct_messages',
  'direct_conversations',
  'work_item_comments',
  'work_item_files',
  'work_items',
  'document_comments',
  'documents',
  'decision_comments',
  'decisions',
  'meeting_attachments',
  'meetings',
  'request_comments',
  'request_messages',
  'file_comments',
  // R4 slice 5 (0268): proofing comments before their threads.
  'review_comments',
  'review_threads',
  'project_update_comments',
  'google_drive_attachments',
  'onedrive_attachments',
]);

/** The most rows one table gives up in one run. */
export const PURGE_BATCH = 500;

/** One row past its restore window, as the store reads it. */
export interface DuePurgeRow {
  readonly organizationId: string;
  readonly id: string;
}

/** What one tenant-scoped delete did. */
export interface PurgeDeleteResult {
  readonly deleted: number;
  /** Rows a live row still references (errno 1451), left for the next run. */
  readonly blocked: number;
}

/** The statements the purge needs. Faked by the unit test. */
export interface ContentPurgeStore {
  /** Rows of `table` past `purge_after` (database clock), oldest first, at most `limit`. */
  listDue(table: string, limit: number): Promise<readonly DuePurgeRow[]>;
  /** Delete these rows of one organization, re-checking the purge predicate in the DELETE. */
  deleteDue(
    table: string,
    organizationId: string,
    ids: readonly string[],
  ): Promise<PurgeDeleteResult>;
}

/** A purge another slice adds — PA-07's organization purge is the first. */
export interface PurgeHook {
  readonly name: string;
  /** Run one bounded pass; returns how many records it removed. */
  run(database: WorkerDatabase): Promise<number>;
}

/** The hooks every `--sweep-purge` run calls after the content tables. Append-only. */
export const PURGE_HOOKS: PurgeHook[] = [];

export interface PurgeTableReport {
  readonly table: string;
  readonly deleted: number;
  readonly blocked: number;
}

export interface PurgeReport {
  readonly deleted: number;
  readonly blocked: number;
  readonly tables: readonly PurgeTableReport[];
  readonly hooks: readonly { readonly name: string; readonly removed: number }[];
}

export interface RunPurgeOptions {
  readonly store?: ContentPurgeStore;
  readonly batch?: number;
  readonly tables?: readonly string[];
}

/** Run one purge pass: every content table, then every hook. */
export async function runPurge(
  database: WorkerDatabase,
  hooks: readonly PurgeHook[] = PURGE_HOOKS,
  options: RunPurgeOptions = {},
): Promise<PurgeReport> {
  const store = options.store ?? createContentPurgeStore(database);
  const batch = options.batch ?? PURGE_BATCH;
  const tables: PurgeTableReport[] = [];
  for (const table of options.tables ?? CONTENT_PURGE_TABLES) {
    const due = await store.listDue(table, batch);
    let deleted = 0;
    let blocked = 0;
    for (const [organizationId, ids] of groupByOrganization(due)) {
      const result = await store.deleteDue(table, organizationId, ids);
      deleted += result.deleted;
      blocked += result.blocked;
    }
    tables.push({ table, deleted, blocked });
  }
  const hookReports: { name: string; removed: number }[] = [];
  for (const hook of hooks) {
    hookReports.push({ name: hook.name, removed: await hook.run(database) });
  }
  return {
    deleted: tables.reduce((sum, table) => sum + table.deleted, 0),
    blocked: tables.reduce((sum, table) => sum + table.blocked, 0),
    tables,
    hooks: hookReports,
  };
}

function groupByOrganization(rows: readonly DuePurgeRow[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const row of rows) {
    const ids = groups.get(row.organizationId);
    if (ids === undefined) groups.set(row.organizationId, [row.id]);
    else ids.push(row.id);
  }
  return groups;
}
