import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { projectCommitValues, validateBatch } from './import-validation.js';
import type {
  ImportSourceKind,
  ImportValidationStatus,
  RowValidationError,
  SourceMapping,
  SourceRow,
} from './import-validation.js';
import { ImportJobsRepository } from './import-jobs.repository.js';
import { ImportRowsRepository } from './import-rows.repository.js';
import type { ImportRowOutcome } from './import-rows.repository.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import type { CreateProjectInput } from '../projects/projects.repository.js';

/**
 * ON-09's validate / dry-run service.
 *
 * It runs the pure {@link validateBatch}, persists the *attempt* as one `import_jobs` row inside
 * a transaction, and returns the report with the persisted job id. It **commits no target
 * entity**, and that is structural rather than a promise: this service is constructed with a
 * database and the import-jobs repository only — it holds no projects or work repository to
 * write through, so the single write it can perform is the job record. The commit half that
 * creates entities from a validated job is a separate slice with its own dependencies.
 */

export interface ImportValidationRequest {
  readonly sourceKind: ImportSourceKind;
  readonly mapping: SourceMapping;
  readonly rows: readonly SourceRow[];
}

/**
 * The wire shape `POST …/imports/validations` returns — the validation report plus the id of the
 * persisted attempt. CONTRACT-001: no `apps/web` consumer this slice (the ON-09 screen is the
 * follow-up), so it is exempt in `scripts/contracts-check.mjs` and documented, not paired, in
 * `e2e/contracts/api-web-shapes.ts`.
 */
export interface ImportValidationView {
  readonly jobId: string;
  readonly sourceKind: ImportSourceKind;
  readonly status: ImportValidationStatus;
  readonly totalCount: number;
  readonly validCount: number;
  readonly invalidCount: number;
  readonly errors: readonly RowValidationError[];
}

/**
 * The commit request. It re-supplies the batch (mapping + rows) alongside the id of the job
 * validated earlier, because `import_jobs` records the *outcome* of a validation, not the row
 * payloads — the commit half re-validates the batch it is handed and creates entities from the
 * rows that pass. The `sourceKind` must match the job's, so a validated `project` job cannot be
 * committed as some other kind.
 */
export interface ImportCommitRequest {
  readonly jobId: string;
  readonly sourceKind: ImportSourceKind;
  readonly mapping: SourceMapping;
  readonly rows: readonly SourceRow[];
}

/** A terminal committed status. Partial failure lands on `committed_with_errors`. */
export type ImportCommitStatus = 'committed' | 'committed_with_errors';

/** One source row's receipt in the response — ADM-10's "receipt" at row granularity. */
export interface ImportCommitRowView {
  readonly sourceIndex: number;
  readonly outcome: ImportRowOutcome;
  /** The created entity's id for a `created` row; `null` for a `failed` one. */
  readonly createdEntityId: string | null;
  /** The validation / authorization error for a `failed` row; `null` for a `created` one. */
  readonly error: string | null;
}

/**
 * The wire shape `POST …/imports/commits` returns — the terminal job status, the committed /
 * failed counts, and the per-row receipt. CONTRACT-001: no `apps/web` consumer this slice (the
 * ON-09 screen is the follow-up), so it is exempt in `scripts/contracts-check.mjs` and
 * documented, not paired, in `e2e/contracts/api-web-shapes.ts` — the same treatment
 * `ImportValidationView` carries.
 */
export interface ImportCommitView {
  readonly jobId: string;
  readonly sourceKind: ImportSourceKind;
  readonly status: ImportCommitStatus;
  readonly committedCount: number;
  readonly failedCount: number;
  readonly rows: readonly ImportCommitRowView[];
}

/** The `import_jobs` statuses a job must be in to be committable (the validate-half outcomes). */
const COMMITTABLE_STATUSES: ReadonlySet<string> = new Set(['validated', 'validated_with_errors']);

/**
 * The terminal statuses a job carries once it has been committed — the only states in which a
 * receipt exists to read. A validate-only job (`validated` / `validated_with_errors`) has no
 * `import_rows` and no committed/failed summary yet, so it has no receipt; the read reports that
 * as a 404 rather than inventing an empty one, which also keeps {@link ImportCommitView.status}
 * honest (it is exactly one of these two).
 */
const COMMITTED_STATUSES: ReadonlySet<string> = new Set(['committed', 'committed_with_errors']);

/** A field-error summary bounded to the receipt column width, for a row that failed re-validation. */
const MAX_ERROR_DETAIL = 500;

export class ImportService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly jobs: ImportJobsRepository = new ImportJobsRepository(),
    private readonly rows: ImportRowsRepository = new ImportRowsRepository(),
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
  ) {}

  async validate(
    context: TenantContext,
    request: ImportValidationRequest,
  ): Promise<ImportValidationView> {
    const report = validateBatch(request.sourceKind, request.mapping, request.rows);

    const job = await this.database.transaction(context, (tx) =>
      this.jobs.create(tx, context, {
        createdByUserId: context.userId,
        sourceKind: report.sourceKind,
        status: report.status,
        totalCount: report.totalCount,
        validCount: report.validCount,
        invalidCount: report.invalidCount,
      }),
    );

    return {
      jobId: job.id,
      sourceKind: report.sourceKind,
      status: report.status,
      totalCount: report.totalCount,
      validCount: report.validCount,
      invalidCount: report.invalidCount,
      errors: report.errors,
    };
  }

  /**
   * Commit a previously-validated job: create the target entities from the rows that pass, record
   * a per-row receipt, and transition the job to its terminal committed status.
   *
   * ## Partial commit, not all-or-nothing
   *
   * ON-09 names "partial failure" explicitly, and Peter's decision for this slice is a partial
   * commit with a per-row receipt (not all-or-nothing): the valid rows are created and the invalid
   * / refused rows are recorded as errors, in one transaction. A row's failure does not throw and
   * does not roll back the rows that succeeded — it is written to `import_rows` and the job lands
   * on `committed_with_errors`. The transaction is a consistency boundary (all receipts + the job
   * transition commit together), not an all-or-nothing gate on the entity creates.
   *
   * ## Authorization is no broader than a manual create
   *
   * The route capability (`org.manage`) is the coarse gate. Each row additionally passes the
   * object-layer `project.create` `authorize()` — the same decision a manual create makes — so an
   * import can create nothing a principal could not create by hand. A denied row is recorded as a
   * `failed` receipt rather than aborting the commit.
   */
  async commit(
    context: TenantContext,
    principal: Principal,
    request: ImportCommitRequest,
  ): Promise<ImportCommitView> {
    // Load the job tenant-scoped. A job of another tenant reads as null here (the repository's
    // predicate), so a cross-tenant commit is a 404, never a 500 and never a leak.
    const job = await this.database.read(context, (runner) =>
      this.jobs.findById(runner, context, request.jobId),
    );
    if (!job) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'import_job_not_visible');
    }

    // A job can only be committed once, and only from a validate-half state. An already-committed
    // or otherwise non-validated job is refused rather than committed a second time.
    if (!COMMITTABLE_STATUSES.has(job.status)) {
      throw new ApiError(
        409,
        'conflict',
        'This import job is not in a committable state',
        undefined,
        'import_job_not_committable',
      );
    }

    // The kind is fixed at validation time; a validated `project` job is not committable as
    // another kind. Guarded before any write.
    if (job.sourceKind !== request.sourceKind) {
      throw new ApiError(
        409,
        'conflict',
        'This import job was validated for a different source kind',
        [{ field: 'sourceKind', message: `does not match the job's ${job.sourceKind}` }],
      );
    }

    // Re-validate the supplied batch. The report's error set is the authority on which rows are
    // committable; `import_jobs` stored only the validate half's counts, not the row payloads.
    const report = validateBatch(request.sourceKind, request.mapping, request.rows);
    const errorsByRow = new Map(report.errors.map((e) => [e.row, e] as const));

    const receipts = await this.database.transaction(context, async (tx) => {
      const written: ImportCommitRowView[] = [];

      for (let index = 0; index < request.rows.length; index += 1) {
        const row = request.rows[index] ?? {};
        const invalid = errorsByRow.get(index);

        if (invalid) {
          written.push(
            await this.recordFailure(tx, context, request.jobId, index, summarizeRowError(invalid)),
          );
          continue;
        }

        // The object-layer create gate, per row: no broader than a manual `project.create`.
        const decision = authorize({
          principal,
          capability: 'project.create',
          resource: {
            organizationId: context.organizationId,
            // A create has no object yet; there is no project relation to gate on.
            projectId: null,
            audience: 'internal',
          },
        });
        if (!decision.allowed) {
          written.push(
            await this.recordFailure(tx, context, request.jobId, index, decision.detail),
          );
          continue;
        }

        const created = await this.projects.create(
          tx,
          context,
          projectCreateInput(request.mapping, row),
        );
        const receipt = await this.rows.create(tx, context, {
          jobId: request.jobId,
          sourceIndex: index,
          outcome: 'created',
          createdEntityId: created.id,
        });
        written.push({
          sourceIndex: receipt.sourceIndex,
          outcome: 'created',
          createdEntityId: created.id,
          error: null,
        });
      }

      const failedCount = written.filter((r) => r.outcome === 'failed').length;
      const committedCount = written.length - failedCount;
      const status: ImportCommitStatus = failedCount > 0 ? 'committed_with_errors' : 'committed';

      await this.jobs.markCommitted(tx, context, request.jobId, {
        status,
        committedCount,
        failedCount,
      });

      return { written, committedCount, failedCount, status };
    });

    return {
      jobId: request.jobId,
      sourceKind: request.sourceKind,
      status: receipts.status,
      committedCount: receipts.committedCount,
      failedCount: receipts.failedCount,
      rows: receipts.written,
    };
  }

  /**
   * Read a committed job's receipt — ON-09 "progress" / ADM-10 "receipt" (x104): the terminal
   * job status, its committed / failed counts, and the per-row `import_rows` outcomes in source
   * order. Pure read; it creates and re-runs nothing.
   *
   * ## Tenant-scoped resolve before anything else (FAST-PROTOCOL "Known trap")
   *
   * The job is named by id. It is loaded tenant-scoped first, so a job that does not exist or
   * belongs to another tenant reads as `null` (the repository's predicate) and surfaces as a
   * **404** — never a 500 the `HttpExceptionFilter` cannot map, and never a foreign tenant's
   * receipt. The per-row read is filtered by the same tenant and parent job, so a receipt can
   * only cite rows of the caller's own job.
   *
   * A job that has not been committed yet has no receipt (no `import_rows`, no committed/failed
   * summary), so it is a 404 as well rather than an empty, misleading receipt.
   */
  async getReceipt(context: TenantContext, jobId: string): Promise<ImportCommitView> {
    const found = await this.database.read(context, async (runner) => {
      const job = await this.jobs.findById(runner, context, jobId);
      // Resolve the named job tenant-scoped BEFORE any further read. A missing or cross-tenant
      // id stops here — no receipt rows are read for a job the caller cannot see.
      if (!job) return null;
      const rows = await this.rows.listByJob(runner, context, jobId);
      return { job, rows };
    });

    if (!found || !COMMITTED_STATUSES.has(found.job.status)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'import_receipt_not_visible');
    }

    return {
      jobId: found.job.id,
      sourceKind: found.job.sourceKind as ImportSourceKind,
      // Guarded by COMMITTED_STATUSES above, so the cast is a narrowing the check has proven.
      status: found.job.status as ImportCommitStatus,
      // Non-null once committed (0032 stamps all three in the commit transition); `?? 0` is a
      // defensive floor, not an expected path.
      committedCount: found.job.committedCount ?? 0,
      failedCount: found.job.failedCount ?? 0,
      // Already ordered by source index in the repository.
      rows: found.rows.map((row) => ({
        sourceIndex: row.sourceIndex,
        outcome: row.outcome as ImportRowOutcome,
        createdEntityId: row.createdEntityId,
        error: row.errorDetail,
      })),
    };
  }

  /** Write one `failed` receipt and return its view row. */
  private async recordFailure(
    tx: TenantQueryRunner,
    context: TenantContext,
    jobId: string,
    sourceIndex: number,
    detail: string,
  ): Promise<ImportCommitRowView> {
    const errorDetail = detail.slice(0, MAX_ERROR_DETAIL);
    await this.rows.create(tx, context, {
      jobId,
      sourceIndex,
      outcome: 'failed',
      errorDetail,
    });
    return { sourceIndex, outcome: 'failed', createdEntityId: null, error: errorDetail };
  }
}

/** The `CreateProjectInput` a validated `project` row commits as. */
function projectCreateInput(mapping: SourceMapping, row: SourceRow): CreateProjectInput {
  const values = projectCommitValues(mapping, row);
  return {
    workspaceId: values.workspaceId,
    name: values.name,
    ...(values.forecastAt === undefined ? {} : { forecastAt: values.forecastAt }),
  };
}

/** A compact, column-bounded summary of a row's field errors for the receipt. */
function summarizeRowError(error: RowValidationError): string {
  return error.errors.map((f) => `${f.field}: ${f.message}`).join('; ');
}
