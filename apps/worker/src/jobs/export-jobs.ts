import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { WorkerDatabase } from '../common/database/worker-database.js';
import { escapeCsvCell, toCsv as domainToCsv } from '@tmanage/domain';
import { createExportJobStore } from '../common/database/export-jobs-store.js';

/**
 * platform-admin v2 · PA-09 (SPEC §4 C6, §7 item 12): the CSV export job.
 *
 * The Platform admin queues a row in `platform_export_jobs` (0246); this job, every
 * {@link EXPORT_INTERVAL_MS} in loop mode and once per `--run-exports`:
 *
 * 1. removes files whose 24 hours are up (`ready` → `expired`) and the files of jobs the operator
 *    deleted, and fails a job left `running` past {@link EXPORT_RUNNING_TIMEOUT_MS};
 * 2. claims queued jobs one at a time (`FOR UPDATE SKIP LOCKED`, so two workers never take the
 *    same one), reads the scope's rows with the stored filter — at most {@link EXPORT_ROW_CAP},
 *    a bigger filter fails with "narrow the filter" — writes the CSV to the object store's
 *    private zone under the job's own key, and stamps `row_count`, `object_key`, `finished_at`
 *    and `expires_at` (24 h), or `error`.
 *
 * The CSV escaping is the domain's one rule (`packages/domain/src/export/csv.ts`, 52-29): a cell
 * starting `=`, `+`, `-`, `@`, tab or CR gets a leading quote (no formula runs in a spreadsheet),
 * then RFC 4180 quoting; CRLF between records.
 *
 * `sign-ins` jobs are not claimed: the relay credential never reads `authentication_events`
 * (least-privilege.db.test.ts), so the API writes that file itself.
 */

export const EXPORT_ROW_CAP = 50_000;
export const EXPORT_BATCH = 5;
export const EXPORT_INTERVAL_MS = 30_000;
export const EXPORT_RUNNING_TIMEOUT_MS = 60 * 60 * 1000;
export const WORKER_EXPORT_SCOPES = ['actions', 'sessions', 'platform', 'orgs', 'people'] as const;
export type WorkerExportScope = (typeof WORKER_EXPORT_SCOPES)[number];

export interface ClaimedExportJob {
  readonly id: string;
  readonly scope: WorkerExportScope;
  readonly filter: Readonly<Record<string, string>>;
}

export interface ExportTable {
  readonly header: readonly string[];
  readonly rows: readonly (readonly (string | null)[])[];
}

export interface RemovableExport {
  readonly id: string;
  readonly objectKey: string;
  /** `expire`: a ready file whose 24 hours are up. `drop`: a deleted or failed job's file. */
  readonly kind: 'expire' | 'drop';
}

/** The statements the job needs. Faked by the unit test. */
export interface ExportJobStore {
  /** Claim the oldest queued job (status → running), or null. */
  claimNext(): Promise<ClaimedExportJob | null>;
  /** The scope's rows with the job's filter, at most `limit` (the caller asks cap + 1). */
  readRows(job: ClaimedExportJob, limit: number): Promise<ExportTable>;
  /** Ready with the file; false when the operator deleted the job meanwhile. */
  finishReady(id: string, rowCount: number, objectKey: string): Promise<boolean>;
  finishFailed(id: string, error: string): Promise<void>;
  listRemovable(limit: number): Promise<readonly RemovableExport[]>;
  markRemoved(file: RemovableExport): Promise<void>;
  /** Fail jobs left running longer than the timeout; returns how many. */
  failStale(timeoutMs: number): Promise<number>;
}

/** Where the file goes: the object store's private zone. */
export interface ExportObjectWriter {
  put(objectKey: string, bytes: Buffer): Promise<void>;
  remove(objectKey: string): Promise<void>;
}

// ── CSV (the domain's one escaping rule, 52-29) ─────────────────────────────

export { escapeCsvCell };

/** The table as CSV, header first, through `@tmanage/domain`'s `toCsv`. */
export function toCsv(table: ExportTable): string {
  return domainToCsv(table.rows, table.header);
}

/** `platform/exports/<jobId>/<random>.csv` — the API's `exportObjectKey`, restated. */
export function exportObjectKey(jobId: string): string {
  return `platform/exports/${jobId}/${randomBytes(16).toString('hex')}.csv`;
}

export interface ExportRunResult {
  readonly written: number;
  readonly failed: number;
  readonly removed: number;
  readonly timedOut: number;
}

export async function runExportJobs(
  store: ExportJobStore,
  writer: ExportObjectWriter | null,
  options: { readonly batch?: number; readonly cap?: number } = {},
): Promise<ExportRunResult> {
  const batch = options.batch ?? EXPORT_BATCH;
  const cap = options.cap ?? EXPORT_ROW_CAP;
  let removed = 0;
  for (const file of await store.listRemovable(100)) {
    if (writer) await writer.remove(file.objectKey);
    await store.markRemoved(file);
    removed += 1;
  }
  const timedOut = await store.failStale(EXPORT_RUNNING_TIMEOUT_MS);
  let written = 0;
  let failed = 0;
  for (let i = 0; i < batch; i += 1) {
    const job = await store.claimNext();
    if (!job) break;
    try {
      if (!writer) throw new Error('No file storage is set up for exports.');
      const table = await store.readRows(job, cap + 1);
      if (table.rows.length > cap) {
        throw new Error(`Over ${cap.toLocaleString('en')} rows. Narrow the filter.`);
      }
      const objectKey = exportObjectKey(job.id);
      await writer.put(objectKey, Buffer.from(toCsv(table), 'utf8'));
      if (await store.finishReady(job.id, table.rows.length, objectKey)) {
        written += 1;
      } else {
        // Deleted while it ran: the file has no row to belong to.
        await writer.remove(objectKey);
      }
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : 'The export failed.';
      await store.finishFailed(job.id, message.slice(0, 500));
    }
  }
  return { written, failed, removed, timedOut };
}

// ── The file system half of the object store (`FilesystemObjectStore`'s layout) ──────────────

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** `<root>/objects/private/<key>` — the layout the API's `FilesystemObjectStore` reads. */
export function privateObjectPath(root: string, objectKey: string): string {
  const segments = objectKey.split('/');
  if (segments.length === 0 || !segments.every((segment) => SAFE_SEGMENT.test(segment))) {
    throw new Error('unsafe export object key');
  }
  const base = path.resolve(root, 'objects', 'private');
  const target = path.resolve(base, ...segments);
  if (!target.startsWith(base + path.sep)) throw new Error('unsafe export object key');
  return target;
}

export function filesystemExportWriter(root: string): ExportObjectWriter {
  return {
    async put(objectKey, bytes) {
      const target = privateObjectPath(root, objectKey);
      await mkdir(path.dirname(target), { recursive: true });
      const staging = `${target}.${randomBytes(6).toString('hex')}.part`;
      await writeFile(staging, bytes);
      await rename(staging, target);
    },
    async remove(objectKey) {
      await rm(privateObjectPath(root, objectKey), { force: true });
    },
  };
}

/**
 * The writer for the configured driver: `local` (STORAGE_LOCAL_ROOT) and `filesystem`
 * (STORAGE_FILESYSTEM_ROOT, the dev/e2e substitute) share the API's layout; `s3` has no driver
 * yet, so jobs fail with a plain message instead of writing nowhere.
 */
export function exportWriterFor(env: {
  readonly STORAGE_DRIVER: string;
  readonly STORAGE_LOCAL_ROOT?: string | undefined;
  readonly STORAGE_FILESYSTEM_ROOT: string;
}): ExportObjectWriter | null {
  if (env.STORAGE_DRIVER === 'local' && env.STORAGE_LOCAL_ROOT) {
    return filesystemExportWriter(env.STORAGE_LOCAL_ROOT);
  }
  if (env.STORAGE_DRIVER === 'filesystem')
    return filesystemExportWriter(env.STORAGE_FILESYSTEM_ROOT);
  return null;
}

/** `--run-exports`: one pass over the worker's pool. */
export function runExportJobsOnce(
  database: WorkerDatabase,
  writer: ExportObjectWriter | null,
): Promise<ExportRunResult> {
  return runExportJobs(createExportJobStore(database), writer);
}

/** Loop mode: one pass now and one every {@link EXPORT_INTERVAL_MS} until the signal aborts. */
export async function runExportJobsLoop(
  database: WorkerDatabase,
  writer: ExportObjectWriter | null,
  signal: AbortSignal,
  onError: (error: unknown) => void = (error) => {
    console.error('[worker] export jobs failed', error);
  },
  intervalMs = EXPORT_INTERVAL_MS,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const result = await runExportJobsOnce(database, writer);
      if (result.written + result.failed + result.removed > 0) {
        console.warn(
          `[worker] exports: wrote ${String(result.written)}, failed ${String(result.failed)}, ` +
            `removed ${String(result.removed)}`,
        );
      }
    } catch (error) {
      onError(error);
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
