import { describe, expect, it } from 'vitest';
import { IMPORT_SOURCE_KINDS, isImportSourceKind, validateBatch } from './import-validation.js';
import type { SourceMapping, SourceRow } from './import-validation.js';
import { parseImportValidationBody } from './import-input.js';
import type { ValidationDetail } from './import-input.js';
import { ImportService } from './import.service.js';
import type { CreateImportJobInput, ImportJobsRepository } from './import-jobs.repository.js';
import type { ImportJobRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * ON-09 first vertical slice — the validate / dry-run half of import.
 *
 * The unit under test is the pure validation of a batch against a source mapping (the report
 * that surfaces partial failure without touching a target entity), the untrusted-input parse
 * at the HTTP boundary, and the service that persists the attempt as one `import_jobs` row and
 * returns its id. The migration + tenant-scoped round-trip is the DB case in
 * `apps/api/test/migrator.db.test.ts`; this file proves the outcomes.
 */

/** The first (and, this slice, only) source kind: rows that become projects in the commit half. */
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

describe('validateBatch', () => {
  it('reports zero errors and `validated` for an all-valid batch', () => {
    const report = validateBatch('project', PROJECT_MAPPING, [projectRow(), projectRow()]);
    expect(report.status).toBe('validated');
    expect(report.totalCount).toBe(2);
    expect(report.validCount).toBe(2);
    expect(report.invalidCount).toBe(0);
    expect(report.errors).toEqual([]);
  });

  it('reports the exact invalid rows and `validated_with_errors` for a mixed batch', () => {
    const rows = [
      projectRow(), // 0 valid
      projectRow({ 'Project Name': '   ' }), // 1 blank name
      projectRow(), // 2 valid
      projectRow({ Workspace: undefined, Due: 'not-a-date' }), // 3 two errors
    ];
    const report = validateBatch('project', PROJECT_MAPPING, rows);
    expect(report.status).toBe('validated_with_errors');
    expect(report.totalCount).toBe(4);
    expect(report.validCount).toBe(2);
    expect(report.invalidCount).toBe(2);
    // Only the offending rows appear, by their index in the batch — partial failure, not
    // an all-or-nothing rejection.
    expect(report.errors.map((e) => e.row)).toEqual([1, 3]);
    expect(report.errors[0]?.errors.map((d) => d.field)).toEqual(['name']);
    expect(report.errors[1]?.errors.map((d) => d.field).sort()).toEqual([
      'targetDate',
      'workspaceId',
    ]);
  });

  it('rejects a name over 190 characters', () => {
    const report = validateBatch('project', PROJECT_MAPPING, [
      projectRow({ 'Project Name': 'x'.repeat(191) }),
    ]);
    expect(report.invalidCount).toBe(1);
    expect(report.errors[0]?.errors.map((d) => d.field)).toEqual(['name']);
  });

  it('treats an absent optional targetDate as valid but a present malformed one as invalid', () => {
    const withoutDate = validateBatch('project', PROJECT_MAPPING, [projectRow({ Due: undefined })]);
    expect(withoutDate.validCount).toBe(1);
    const withBadDate = validateBatch('project', PROJECT_MAPPING, [
      projectRow({ Due: '2026-02-31' }),
    ]);
    expect(withBadDate.errors[0]?.errors.map((d) => d.field)).toEqual(['targetDate']);
  });

  it('reports the documented empty value for an empty batch', () => {
    const report = validateBatch('project', PROJECT_MAPPING, []);
    expect(report.status).toBe('validated');
    expect(report.totalCount).toBe(0);
    expect(report.validCount).toBe(0);
    expect(report.invalidCount).toBe(0);
    expect(report.errors).toEqual([]);
  });

  it('exposes the closed source-kind vocabulary', () => {
    expect([...IMPORT_SOURCE_KINDS]).toContain('project');
    expect(isImportSourceKind('project')).toBe(true);
    expect(isImportSourceKind('users')).toBe(false);
    expect(isImportSourceKind(42)).toBe(false);
  });
});

function fields(details: ValidationDetail[]): string[] {
  return details.map((d) => d.field);
}

describe('parseImportValidationBody', () => {
  const good = () => ({
    sourceKind: 'project',
    mapping: { name: 'A', workspaceId: 'B' },
    rows: [{ A: 'x', B: 'y' }],
  });

  it('accepts the contract shape', () => {
    const details: ValidationDetail[] = [];
    const parsed = parseImportValidationBody(good(), details);
    expect(details).toEqual([]);
    expect(parsed).toEqual(good());
  });

  it('refuses an unknown source kind', () => {
    const details: ValidationDetail[] = [];
    expect(parseImportValidationBody({ ...good(), sourceKind: 'users' }, details)).toBeUndefined();
    expect(fields(details)).toContain('sourceKind');
  });

  it('refuses a mapping that is not a string-to-string object', () => {
    const details: ValidationDetail[] = [];
    parseImportValidationBody({ ...good(), mapping: { name: 5 } }, details);
    expect(fields(details)).toContain('mapping');
  });

  it('refuses rows that are not an array of objects', () => {
    for (const rows of [null, 'x', [1, 2], [null]]) {
      const details: ValidationDetail[] = [];
      parseImportValidationBody({ ...good(), rows }, details);
      expect(fields(details), JSON.stringify(rows)).toContain('rows');
    }
  });

  it('refuses a batch larger than the cap before validating it', () => {
    const details: ValidationDetail[] = [];
    const rows = Array.from({ length: 1001 }, () => ({ A: 'x', B: 'y' }));
    expect(parseImportValidationBody({ ...good(), rows }, details)).toBeUndefined();
    expect(fields(details)).toContain('rows');
  });
});

const CONTEXT = { organizationId: 'org-1', userId: 'user-1' } as TenantContext;

/** A fake database whose `transaction` runs the unit of work with an ignored runner. */
function fakeDatabase(): TenantDatabase {
  const runner = {} as never;
  return {
    transaction: <T>(_c: TenantContext, work: (tx: never) => Promise<T>): Promise<T> =>
      work(runner),
  } as unknown as TenantDatabase;
}

/** A fake repository that records the one insert and hands back a row with a fixed id. */
function fakeJobs(): { repo: ImportJobsRepository; created: CreateImportJobInput[] } {
  const created: CreateImportJobInput[] = [];
  const repo = {
    create: async (
      _runner: unknown,
      context: TenantContext,
      input: CreateImportJobInput,
    ): Promise<ImportJobRow> => {
      created.push(input);
      return {
        id: 'job-1',
        organizationId: context.organizationId,
        createdByUserId: input.createdByUserId,
        sourceKind: input.sourceKind,
        status: input.status,
        totalCount: input.totalCount,
        validCount: input.validCount,
        invalidCount: input.invalidCount,
        createdAt: new Date(),
        // Commit-half columns (0032): NULL for a validate-only job.
        committedAt: null,
        committedCount: null,
        failedCount: null,
      } satisfies ImportJobRow;
    },
  } as unknown as ImportJobsRepository;
  return { repo, created };
}

describe('ImportService.validate', () => {
  it('persists one job carrying the counts and status, and returns the report with its id', async () => {
    const { repo, created } = fakeJobs();
    const service = new ImportService(fakeDatabase(), repo);

    const view = await service.validate(CONTEXT, {
      sourceKind: 'project',
      mapping: PROJECT_MAPPING,
      rows: [projectRow(), projectRow({ 'Project Name': '' })],
    });

    // The durable anchor: exactly one import_jobs row, with the report's own counts.
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      createdByUserId: 'user-1',
      sourceKind: 'project',
      status: 'validated_with_errors',
      totalCount: 2,
      validCount: 1,
      invalidCount: 1,
    });

    // The response carries the persisted id and surfaces the offending row.
    expect(view.jobId).toBe('job-1');
    expect(view.status).toBe('validated_with_errors');
    expect(view.invalidCount).toBe(1);
    expect(view.errors.map((e) => e.row)).toEqual([1]);
  });

  it('persists a `validated` job for an all-valid batch and commits no target entity', async () => {
    const { repo, created } = fakeJobs();
    // Structural proof of "commits no target entity": the service is constructed with only a
    // database and the import-jobs repository — it holds no projects/work repository to write
    // through. The only write it can make is the job record asserted here.
    const service = new ImportService(fakeDatabase(), repo);

    const view = await service.validate(CONTEXT, {
      sourceKind: 'project',
      mapping: PROJECT_MAPPING,
      rows: [projectRow()],
    });

    expect(created).toHaveLength(1);
    expect(created[0]?.status).toBe('validated');
    expect(view.status).toBe('validated');
    expect(view.validCount).toBe(1);
    expect(view.errors).toEqual([]);
  });
});
