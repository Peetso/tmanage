import { describe, expect, it } from 'vitest';
import { ImportService } from './import.service.js';
import type { ImportJobsRepository } from './import-jobs.repository.js';
import type { ImportRowsRepository } from './import-rows.repository.js';
import type { ImportJobRow, ImportRowRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ApiError } from '../../common/http/errors.js';

/**
 * ON-09 / ADM-10 receipt read (x104) — `ImportService.getReceipt`, over fakes.
 *
 * The unit under test composes a committed job's header with its per-row `import_rows` outcomes
 * into the `ImportCommitView` receipt. The migration + tenant-scoped round-trip is DB-proven by
 * x95/x100 (`import_jobs`/`import_rows`, migrator 0028/0032); this file proves the read's
 * composition and its guards without a database.
 *
 * Known-trap coverage (FAST-PROTOCOL, 19:55): the job is named by id, so it is resolved
 * tenant-scoped BEFORE any receipt row is read. `makeService(null)` stands in for both "no such
 * job" and "another tenant's job" — the scoped `findById` returns null for each — and the read
 * must be a 404, never a 500 and never a foreign tenant's receipt.
 */

const CONTEXT = { organizationId: 'org-1', userId: 'user-1' } as TenantContext;

const JOB_ID = '00000000-0000-4000-8000-000000000001';

/** A committed job header, terminal status stamped with its receipt summary. */
function committedJob(over: Partial<ImportJobRow> = {}): ImportJobRow {
  return {
    id: JOB_ID,
    organizationId: 'org-1',
    createdByUserId: 'user-1',
    sourceKind: 'project',
    status: 'committed',
    totalCount: 2,
    validCount: 2,
    invalidCount: 0,
    createdAt: new Date(),
    committedAt: new Date(),
    committedCount: 2,
    failedCount: 0,
    undoneAt: null,
    undoneByUserId: null,
    undoneCount: null,
    ...over,
  };
}

/** One `import_rows` receipt row. */
function receiptRow(over: Partial<ImportRowRow> = {}): ImportRowRow {
  return {
    id: `row-${over.sourceIndex ?? 0}`,
    organizationId: 'org-1',
    jobId: JOB_ID,
    sourceIndex: 0,
    outcome: 'created',
    createdEntityId: 'proj-1',
    errorDetail: null,
    createdAt: new Date(),
    entityType: null,
    ...over,
  };
}

interface Fakes {
  service: ImportService;
  listByJobCalls: string[];
}

/**
 * Wire the service with fakes: `findById` returns the given job (or null for an unknown /
 * cross-tenant id), and `listByJob` returns the given rows in the order it is handed them (the
 * real repository orders by `source_index`; the fake preserves whatever the test supplies so a
 * test can assert the service does not reorder).
 */
function makeService(job: ImportJobRow | null, rows: readonly ImportRowRow[] = []): Fakes {
  const listByJobCalls: string[] = [];

  const runner = {} as never;
  const database = {
    read: <T>(_c: TenantContext, work: (r: never) => Promise<T>): Promise<T> => work(runner),
    transaction: <T>(_c: TenantContext, work: (tx: never) => Promise<T>): Promise<T> =>
      work(runner),
  } as unknown as TenantDatabase;

  const jobs = {
    findById: async (): Promise<ImportJobRow | null> => job,
  } as unknown as ImportJobsRepository;

  const rowsRepo = {
    listByJob: async (
      _r: unknown,
      _c: TenantContext,
      jobId: string,
    ): Promise<readonly ImportRowRow[]> => {
      listByJobCalls.push(jobId);
      return rows;
    },
  } as unknown as ImportRowsRepository;

  return {
    service: new ImportService(database, jobs, rowsRepo, undefined),
    listByJobCalls,
  };
}

describe('ImportService.getReceipt', () => {
  it('returns a committed_with_errors job header, counts, and per-row outcomes in source order', async () => {
    const { service } = makeService(
      committedJob({
        status: 'committed_with_errors',
        totalCount: 3,
        committedCount: 2,
        failedCount: 1,
      }),
      [
        receiptRow({ sourceIndex: 0, outcome: 'created', createdEntityId: 'proj-a' }),
        receiptRow({
          sourceIndex: 1,
          outcome: 'failed',
          createdEntityId: null,
          errorDetail: 'name: must be a non-empty string',
        }),
        receiptRow({ sourceIndex: 2, outcome: 'created', createdEntityId: 'proj-c' }),
      ],
    );

    const view = await service.getReceipt(CONTEXT, JOB_ID);

    expect(view.jobId).toBe(JOB_ID);
    expect(view.sourceKind).toBe('project');
    expect(view.status).toBe('committed_with_errors');
    expect(view.committedCount).toBe(2);
    expect(view.failedCount).toBe(1);
    // Per-row outcomes, in source order, with the created ids and the error text preserved.
    expect(view.rows.map((r) => r.sourceIndex)).toEqual([0, 1, 2]);
    expect(view.rows.map((r) => r.outcome)).toEqual(['created', 'failed', 'created']);
    expect(view.rows[0]?.createdEntityId).toBe('proj-a');
    expect(view.rows[1]?.createdEntityId).toBeNull();
    expect(view.rows[1]?.error).toContain('name');
    expect(view.rows[2]?.createdEntityId).toBe('proj-c');
  });

  it('returns zero errors and only created rows for an all-valid committed job', async () => {
    const { service } = makeService(committedJob(), [
      receiptRow({ sourceIndex: 0, outcome: 'created', createdEntityId: 'proj-a' }),
      receiptRow({ sourceIndex: 1, outcome: 'created', createdEntityId: 'proj-b' }),
    ]);

    const view = await service.getReceipt(CONTEXT, JOB_ID);

    expect(view.status).toBe('committed');
    expect(view.committedCount).toBe(2);
    expect(view.failedCount).toBe(0);
    expect(view.rows.every((r) => r.outcome === 'created')).toBe(true);
    expect(view.rows.every((r) => r.error === null)).toBe(true);
  });

  it('resolves the named job tenant-scoped first: an unknown / cross-tenant id is a 404, no row read', async () => {
    // `makeService(null)` is both "no such job" and "another tenant's job": the scoped findById
    // returns null for each. The read must stop at the header — never a 500, never a foreign
    // receipt, and no receipt rows fetched for a job the caller cannot see.
    const { service, listByJobCalls } = makeService(null);

    const error = await service.getReceipt(CONTEXT, JOB_ID).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404 });
    expect(listByJobCalls).toHaveLength(0);
  });

  it('treats a job that is not yet committed as having no receipt (404), not an empty one', async () => {
    // A validate-only job has no import_rows and no committed/failed summary, so there is no
    // receipt to read. Reporting it as a 404 keeps ImportCommitView.status honest.
    const { service } = makeService(committedJob({ status: 'validated', committedCount: null }));

    const error = await service.getReceipt(CONTEXT, JOB_ID).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404 });
  });
});
