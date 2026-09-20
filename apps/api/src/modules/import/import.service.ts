import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { validateBatch } from './import-validation.js';
import type {
  ImportSourceKind,
  ImportValidationStatus,
  RowValidationError,
  SourceMapping,
  SourceRow,
} from './import-validation.js';
import { ImportJobsRepository } from './import-jobs.repository.js';

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

export class ImportService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly jobs: ImportJobsRepository = new ImportJobsRepository(),
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
}
