import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ImportService } from './import.service.js';
import type { ImportCommitRequest } from './import.service.js';
import type { CommitImportJobInput } from './import-jobs.repository.js';
import type { ImportJobsRepository } from './import-jobs.repository.js';
import type { CreateImportRowInput, ImportRowsRepository } from './import-rows.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { SourceMapping, SourceRow } from './import-validation.js';
import type { ImportJobRow, ProjectRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ApiError } from '../../common/http/errors.js';

/**
 * ON-09 commit half (x100) — creating target entities from a validated job, over fakes.
 *
 * The unit under test is `ImportService.commit`: it re-validates the supplied batch, creates a
 * project for each row that passes **and** clears the object-layer `project.create` authorize,
 * records a per-row receipt in `import_rows`, and transitions the job to a terminal status. The
 * migration + tenant-scoped round-trip is the DB case in `test/import-002-commit.db.test.ts`;
 * this file proves the outcomes without a database.
 *
 * Partial commit (Peter's decision for this slice) is the point: a mixed job creates the valid
 * rows and records the invalid / refused ones as errors — never all-or-nothing.
 */

const CONTEXT = { organizationId: 'org-1', userId: 'user-1' } as TenantContext;

const PROJECT_MAPPING: SourceMapping = {
  name: 'Project Name',
  workspaceId: 'Workspace',
  targetDate: 'Due',
};

function projectRow(over: Record<string, unknown> = {}): SourceRow {
  return {
    'Project Name': 'Launch site',
    Workspace: '019203a4-5b6c-7d8e-9f01-23456789abce',
    Due: '2026-10-15',
    ...over,
  };
}

/** An owner principal: holds `org.manage` (the route gate) and `project.create` (the row gate). */
function ownerPrincipal(): Principal {
  return {
    userId: 'user-1',
    organizationId: 'org-1',
    kind: 'internal',
    role: 'owner',
    membershipId: 'm-1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

interface Fakes {
  service: ImportService;
  created: { workspaceId: string; name: string }[];
  receipts: CreateImportRowInput[];
  committed: CommitImportJobInput[];
}

/** Wire the service with fakes around a job in the given starting state. */
function makeService(job: ImportJobRow | null): Fakes {
  const created: { workspaceId: string; name: string }[] = [];
  const receipts: CreateImportRowInput[] = [];
  const committed: CommitImportJobInput[] = [];

  const runner = {} as never;
  const database = {
    read: <T>(_c: TenantContext, work: (r: never) => Promise<T>): Promise<T> => work(runner),
    transaction: <T>(_c: TenantContext, work: (tx: never) => Promise<T>): Promise<T> =>
      work(runner),
  } as unknown as TenantDatabase;

  const jobs = {
    findById: async (): Promise<ImportJobRow | null> => job,
    markCommitted: async (
      _r: unknown,
      _c: TenantContext,
      _id: string,
      input: CommitImportJobInput,
    ): Promise<ImportJobRow> => {
      committed.push(input);
      return { ...(job as ImportJobRow), status: input.status };
    },
  } as unknown as ImportJobsRepository;

  let rowSeq = 0;
  const rows = {
    create: async (
      _r: unknown,
      _c: TenantContext,
      input: CreateImportRowInput,
    ): Promise<unknown> => {
      receipts.push(input);
      rowSeq += 1;
      return { id: `row-${rowSeq}`, sourceIndex: input.sourceIndex, outcome: input.outcome };
    },
  } as unknown as ImportRowsRepository;

  let projSeq = 0;
  const projects = {
    create: async (
      _r: unknown,
      _c: TenantContext,
      input: { workspaceId: string; name: string },
    ): Promise<ProjectRow> => {
      created.push({ workspaceId: input.workspaceId, name: input.name });
      projSeq += 1;
      return { id: `proj-${projSeq}` } as ProjectRow;
    },
  } as unknown as ProjectsRepository;

  return {
    service: new ImportService(database, jobs, rows, projects),
    created,
    receipts,
    committed,
  };
}

/** A validated job the commit half may act on. */
function validatedJob(over: Partial<ImportJobRow> = {}): ImportJobRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    organizationId: 'org-1',
    createdByUserId: 'user-1',
    sourceKind: 'project',
    status: 'validated',
    totalCount: 0,
    validCount: 0,
    invalidCount: 0,
    createdAt: new Date(),
    committedAt: null,
    committedCount: null,
    failedCount: null,
    ...over,
  };
}

function commitRequest(rows: readonly SourceRow[], jobId = validatedJob().id): ImportCommitRequest {
  return { jobId, sourceKind: 'project', mapping: PROJECT_MAPPING, rows };
}

describe('ImportService.commit', () => {
  it('creates an entity per row for an all-valid job and reaches committed with zero errors', async () => {
    const { service, created, receipts, committed } = makeService(validatedJob());

    const view = await service.commit(
      CONTEXT,
      ownerPrincipal(),
      commitRequest([projectRow(), projectRow()]),
    );

    expect(view.status).toBe('committed');
    expect(view.committedCount).toBe(2);
    expect(view.failedCount).toBe(0);
    expect(created).toHaveLength(2);
    // Each receipt is a `created` row carrying the entity id, in source order.
    expect(receipts.map((r) => r.outcome)).toEqual(['created', 'created']);
    expect(view.rows.map((r) => r.outcome)).toEqual(['created', 'created']);
    expect(view.rows.every((r) => r.createdEntityId !== null)).toBe(true);
    // The job is transitioned once, to the terminal state, with the summary counts.
    expect(committed).toEqual([{ status: 'committed', committedCount: 2, failedCount: 0 }]);
  });

  it('commits only the valid rows of a mixed job and records the failures (partial commit)', async () => {
    const { service, created, receipts, committed } = makeService(
      validatedJob({ status: 'validated_with_errors' }),
    );

    const view = await service.commit(
      CONTEXT,
      ownerPrincipal(),
      commitRequest([
        projectRow(), // 0 valid
        projectRow({ 'Project Name': '   ' }), // 1 blank name -> failed
        projectRow(), // 2 valid
      ]),
    );

    expect(view.status).toBe('committed_with_errors');
    expect(view.committedCount).toBe(2);
    expect(view.failedCount).toBe(1);
    // The valid rows created entities; the invalid one did not.
    expect(created).toHaveLength(2);
    const failed = view.rows.find((r) => r.outcome === 'failed');
    expect(failed?.sourceIndex).toBe(1);
    expect(failed?.createdEntityId).toBeNull();
    expect(failed?.error).toContain('name');
    // The receipt for the failed row carries no entity id.
    expect(receipts.find((r) => r.sourceIndex === 1)?.createdEntityId ?? null).toBeNull();
    expect(committed[0]).toEqual({
      status: 'committed_with_errors',
      committedCount: 2,
      failedCount: 1,
    });
  });

  it('records a per-row create-authorize denial as a failure rather than creating the entity', async () => {
    const { service, created, receipts } = makeService(validatedJob());
    // A `member` holds no `project.create` in its ceiling, so the object-layer authorize denies
    // even though the route gate (`org.manage`) is a separate, coarser question. The row is
    // recorded as failed; the commit is no broader than a manual create.
    const member: Principal = { ...ownerPrincipal(), role: 'member', hasOrgWideScope: false };

    const view = await service.commit(CONTEXT, member, commitRequest([projectRow()]));

    expect(created).toHaveLength(0);
    expect(view.status).toBe('committed_with_errors');
    expect(view.committedCount).toBe(0);
    expect(view.failedCount).toBe(1);
    expect(view.rows[0]?.outcome).toBe('failed');
    expect(view.rows[0]?.error).toBeTruthy();
    expect(receipts[0]?.outcome).toBe('failed');
  });

  it('refuses to commit a job that is not in a validated state (already committed)', async () => {
    const { service, created } = makeService(validatedJob({ status: 'committed' }));
    await expect(
      service.commit(CONTEXT, ownerPrincipal(), commitRequest([projectRow()])),
    ).rejects.toMatchObject({ status: 409 });
    expect(created).toHaveLength(0);
  });

  it('resolves the named job tenant-scoped before any write: an org-wide caller with an unknown job id gets 404, no write', async () => {
    // The named parent (the job id) is resolved tenant-scoped BEFORE the relation check and
    // before the transaction opens, so a missing or cross-tenant id surfaces as 404 — never a
    // 500 the HttpExceptionFilter cannot map, and never a partial write. `makeService(null)`
    // stands in for both "no such job" and "another tenant's job": the scoped `findById` returns
    // null for each.
    const { service, created, receipts, committed } = makeService(null);

    const error = await service
      .commit(CONTEXT, ownerPrincipal(), commitRequest([projectRow()]))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404 });
    // Nothing was written: no entity created, no receipt, no job transition.
    expect(created).toHaveLength(0);
    expect(receipts).toHaveLength(0);
    expect(committed).toHaveLength(0);
  });

  it('refuses to commit a job validated for a different source kind', async () => {
    const { service } = makeService(validatedJob({ sourceKind: 'something_else' }));
    await expect(
      service.commit(CONTEXT, ownerPrincipal(), commitRequest([projectRow()])),
    ).rejects.toMatchObject({ status: 409 });
  });
});
