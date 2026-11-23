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
  ImportBatchError,
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
import { WorkspacesRepository } from '../tenancy/workspaces.repository.js';
import { MembershipsRepository } from '../tenancy/memberships.repository.js';
import { WorkKeysRepository } from '../work/work-keys.repository.js';
import { WorkItemsRepository } from '../work/work-items.repository.js';
import { WorkLabelsRepository } from '../work/work-labels.repository.js';
import { IterationsRepository } from '../iterations/iterations.repository.js';
import type { JiraCommitOptions } from './import-input.js';
import { commitJiraBatch } from './jira-commit.js';
import type { JiraCommitDeps, JiraCommitSummary } from './jira-commit.js';
import { DocumentsRepository } from '../docs/documents.repository.js';
import { ProjectPhasesRepository } from '../projects/phases.repository.js';
import { commitBasecampBatch, commitNotionBatch, undoImportedEntities } from './basecamp-commit.js';
import type {
  BasecampCommitSummary,
  ImportCommitDeps,
  ImportedEntityType,
  ImportRowResult,
  NotionCommitSummary,
  UndoDeps,
} from './basecamp-commit.js';
import { ImportUndoRepository } from './import-undo.repository.js';
import type { ImportedEntity } from './import-undo.repository.js';
import { ImportJobAlreadyUndoneError } from './import-jobs.repository.js';
import { AuditEventsRepository } from '../audit/audit-events.repository.js';
import { commitBoardBatch } from './board-commit.js';
import type { BoardCommitDeps, BoardCommitSummary, BoardRowResult } from './board-commit.js';
import { PmImportRepository } from './pm-import.repository.js';
import { WorkChecklistRepository } from '../work/work-checklist.repository.js';
import { WorkCommentsRepository } from '../work/work-comments.repository.js';

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
  /** R21-e: batch-level problems (`mixed_prefixes`, `too_many_rows`); empty when none. */
  readonly batchErrors: readonly ImportBatchError[];
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
  /** R21-e: required for `jira_issues` (the target project, key keeping, status / user maps). */
  readonly jira?: JiraCommitOptions;
  /** R22-f: required for `notion_database` / `basecamp_messages` (project, status / user maps). */
  readonly options?: JiraCommitOptions;
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
  /**
   * R21-e: the Jira summary — sprints created, items keyed, epics turned into labels, and the
   * receipt notes (`sprint_dates_derived`, `worklogs_not_imported`, …). Only on the commit
   * response of a `jira_issues` batch; not persisted, so the receipt read omits it.
   */
  readonly jira?: JiraCommitSummary;
  /**
   * R22-f: the Notion summary (items, labels, `notion_status_unmapped` / `notion_person_unmatched`
   * notes). Commit response only, like `jira`.
   */
  readonly notion?: NotionCommitSummary;
  /**
   * R22-f: the Basecamp summary (`documentsCreated`, `basecampSkipped` by kind, notes such as
   * `basecamp_schedule_skipped`). Commit response only, like `jira`.
   */
  readonly basecamp?: BasecampCommitSummary;
  /** 54-26: the monday / ClickUp summary (items, subtasks, comments, labels, notes). Commit only. */
  readonly board?: BoardCommitSummary;
  /** R23-e (54-24): when the job was undone, or `null`. Receipt read only. */
  readonly undoneAt?: string | null;
  /** R23-e: how many created entities the undo deleted, or `null` before an undo. */
  readonly undoneCount?: number | null;
  /**
   * R23-e: the end of the one-click undo window (commit + 7 days), or `null` once undone, past
   * the window, or for a kind that cannot be undone (`project`). Receipt read only.
   */
  readonly undoAvailableUntil?: string | null;
}

/** R23-e — `POST …/imports/:jobId/undo`'s answer. */
export interface ImportUndoView {
  readonly jobId: string;
  readonly deleted: number;
  readonly undoneAt: string;
}

/**
 * R31 (A11) — one committed import in `GET …/imports`, the import start page's history row.
 * `undoAvailableUntil` is the window end when the job is committed, not undone, inside 7 days
 * and not a `project` import (projects cannot be undone); the undo route still re-checks every
 * created row, so this is a hint for the button, never the gate.
 */
export interface ImportJobSummaryView {
  readonly jobId: string;
  readonly sourceKind: ImportSourceKind;
  readonly status: ImportCommitStatus;
  readonly totalCount: number;
  readonly committedCount: number;
  readonly failedCount: number;
  readonly createdAt: string;
  readonly committedAt: string | null;
  readonly undoneAt: string | null;
  readonly undoAvailableUntil: string | null;
}

/** R31 (A11) — `GET …/imports`: the most recent committed imports, newest first. */
export interface ImportJobListView {
  readonly jobs: readonly ImportJobSummaryView[];
}

/** How many recent imports the start page lists. */
export const RECENT_IMPORTS_LIMIT = 20;

/** 54-24: the one-click undo is open for 7 days after the commit ("longer via support"). */
export const IMPORT_UNDO_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The entity kinds the undo deletes. `label` rows (Jira epics) are left (54-24 "that nothing else uses"). */
const UNDOABLE_TYPES: ReadonlySet<string> = new Set<ImportedEntityType>([
  'document',
  'work_item',
  'phase',
]);

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
    private readonly workspaces: WorkspacesRepository = new WorkspacesRepository(),
    private readonly jiraDeps: JiraCommitDeps = {
      workKeys: new WorkKeysRepository(),
      workItems: new WorkItemsRepository(),
      iterations: new IterationsRepository(),
      labels: new WorkLabelsRepository(),
      memberships: new MembershipsRepository(),
      now: () => new Date(),
    },
    private readonly importDeps: ImportCommitDeps = {
      documents: new DocumentsRepository(),
      workItems: new WorkItemsRepository(),
      phases: new ProjectPhasesRepository(),
      labels: new WorkLabelsRepository(),
      memberships: new MembershipsRepository(),
      now: () => new Date(),
    },
    private readonly undoRepository: ImportUndoRepository = new ImportUndoRepository(),
    private readonly undoDeps: UndoDeps = {
      documents: undoRepository,
      workItems: new WorkItemsRepository(),
      phases: new ProjectPhasesRepository(),
    },
    private readonly audit: Pick<AuditEventsRepository, 'append'> = new AuditEventsRepository(),
    private readonly boardDeps: BoardCommitDeps = {
      ...importDeps,
      steps: new WorkChecklistRepository(),
      comments: new WorkCommentsRepository(),
      emails: new PmImportRepository(),
    },
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
      batchErrors: report.batchErrors,
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

    // A batch error (two Jira prefixes, too many rows) makes the batch uncommittable as a whole.
    const batchError = report.batchErrors[0];
    if (batchError) {
      throw new ApiError(400, 'validation_failed', batchError.message, [
        { field: 'rows', message: batchError.code },
      ]);
    }

    if (request.sourceKind === 'jira_issues') {
      return this.commitJira(context, principal, request, errorsByRow);
    }
    if (
      request.sourceKind === 'notion_database' ||
      request.sourceKind === 'basecamp_messages' ||
      request.sourceKind === 'monday_board' ||
      request.sourceKind === 'clickup_tasks'
    ) {
      return this.commitTargeted(context, principal, request, errorsByRow);
    }

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

        // The row passed validation and the create authorize. Resolve the named workspace
        // tenant-scoped BEFORE the insert: a well-formed but unknown or cross-tenant workspace
        // id otherwise reaches the projects composite foreign key inside the transaction,
        // turning one bad row into a 500 that rolls back the whole batch and every receipt
        // written before it. Resolved here it becomes a per-row `failed` receipt instead, and
        // partial commit is preserved (FAST-PROTOCOL known trap: resolve a named parent
        // tenant-scoped before the write, so a missing / cross-tenant id is a row failure and
        // never a 500).
        const values = projectCommitValues(request.mapping, row);
        const workspace = await this.workspaces.findById(tx, context, values.workspaceId);
        if (!workspace) {
          written.push(
            await this.recordFailure(
              tx,
              context,
              request.jobId,
              index,
              'workspaceId: no such workspace in this organization',
            ),
          );
          continue;
        }

        const created = await this.projects.create(tx, context, {
          workspaceId: values.workspaceId,
          name: values.name,
          ...(values.forecastAt === undefined ? {} : { forecastAt: values.forecastAt }),
        });
        const receipt = await this.rows.create(tx, context, {
          jobId: request.jobId,
          sourceIndex: index,
          outcome: 'created',
          createdEntityId: created.id,
          entityType: 'project',
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
      throw new ApiError(
        404,
        'not_found',
        MESSAGES.notFound,
        undefined,
        'import_receipt_not_visible',
      );
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
      undoneAt: found.job.undoneAt === null ? null : found.job.undoneAt.toISOString(),
      undoneCount: found.job.undoneCount,
      undoAvailableUntil: undoAvailableUntil(
        found.job,
        found.rows,
        this.importDeps.now().getTime(),
      ),
      // Already ordered by source index in the repository.
      rows: found.rows.map((row) => ({
        sourceIndex: row.sourceIndex,
        outcome: row.outcome as ImportRowOutcome,
        createdEntityId: row.createdEntityId,
        error: row.errorDetail,
      })),
    };
  }

  /** R31 (A11) — the tenant's recent committed imports for the start page (`org.manage`). */
  async listRecent(context: TenantContext): Promise<ImportJobListView> {
    const jobs = await this.database.read(context, (runner) =>
      this.jobs.listRecentCommitted(runner, context, RECENT_IMPORTS_LIMIT),
    );
    const now = this.importDeps.now().getTime();
    return { jobs: jobs.map((job) => importJobSummary(job, now)) };
  }

  /**
   * R21-e — commit a `jira_issues` batch: the writes are `commitJiraBatch`'s, inside one
   * transaction with the per-row receipts and the job transition, exactly as the project kind.
   */
  private async commitJira(
    context: TenantContext,
    principal: Principal,
    request: ImportCommitRequest,
    errorsByRow: ReadonlyMap<number, RowValidationError>,
  ): Promise<ImportCommitView> {
    const options = request.jira;
    if (!options) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'options', message: 'must be an object with a projectId' },
      ]);
    }
    // R23-e: the Jira result does not say what an id is (an epic row cites the label it became),
    // so the item creates are observed here and every other created id is a `label`.
    const createdItems = new Set<string>();
    const baseItems = this.jiraDeps.workItems;
    const jiraDeps: JiraCommitDeps = {
      ...this.jiraDeps,
      workItems: {
        create: async (...args: Parameters<typeof baseItems.create>) => {
          const created = await baseItems.create(...args);
          createdItems.add(created.id);
          return created;
        },
        transitionState: (...args: Parameters<typeof baseItems.transitionState>) =>
          baseItems.transitionState(...args),
      },
    };
    const outcome = await this.database.transaction(context, async (tx) => {
      const { results, summary } = await commitJiraBatch(
        tx,
        context,
        principal,
        {
          mapping: request.mapping,
          rows: request.rows,
          options,
          invalidDetail: (index) => {
            const invalid = errorsByRow.get(index);
            return invalid ? summarizeRowError(invalid) : null;
          },
        },
        this.projects,
        jiraDeps,
      );
      const written: ImportCommitRowView[] = [];
      for (const result of results) {
        if ('error' in result) {
          written.push(
            await this.recordFailure(tx, context, request.jobId, result.index, result.error),
          );
          continue;
        }
        await this.rows.create(tx, context, {
          jobId: request.jobId,
          sourceIndex: result.index,
          outcome: 'created',
          createdEntityId: result.createdEntityId,
          entityType: createdItems.has(result.createdEntityId) ? 'work_item' : 'label',
        });
        written.push({
          sourceIndex: result.index,
          outcome: 'created',
          createdEntityId: result.createdEntityId,
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
      return { written, committedCount, failedCount, status, summary };
    });

    return {
      jobId: request.jobId,
      sourceKind: request.sourceKind,
      status: outcome.status,
      committedCount: outcome.committedCount,
      failedCount: outcome.failedCount,
      rows: outcome.written,
      jira: outcome.summary,
    };
  }

  /**
   * R22-f — commit a `notion_database` / `basecamp_messages` batch into one project: the writes
   * are `basecamp-commit.ts`'s, inside one transaction with the receipts and the job transition.
   * A skipped Basecamp row (Campfire, Hill Chart, schedule, file) has no result and so no receipt.
   */
  private async commitTargeted(
    context: TenantContext,
    principal: Principal,
    request: ImportCommitRequest,
    errorsByRow: ReadonlyMap<number, RowValidationError>,
  ): Promise<ImportCommitView> {
    const options = request.options;
    if (!options) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'options', message: 'must be an object with a projectId' },
      ]);
    }
    const input = {
      mapping: request.mapping,
      rows: request.rows,
      options,
      invalidDetail: (index: number) => {
        const invalid = errorsByRow.get(index);
        return invalid ? summarizeRowError(invalid) : null;
      },
    };
    const outcome = await this.database.transaction(context, async (tx) => {
      let results: readonly (ImportRowResult | BoardRowResult)[];
      let notion: NotionCommitSummary | undefined;
      let basecamp: BasecampCommitSummary | undefined;
      let board: BoardCommitSummary | undefined;
      if (request.sourceKind === 'monday_board' || request.sourceKind === 'clickup_tasks') {
        const done = await commitBoardBatch(
          tx,
          context,
          principal,
          input,
          this.projects,
          this.boardDeps,
        );
        results = done.results;
        board = done.summary;
      } else if (request.sourceKind === 'notion_database') {
        const done = await commitNotionBatch(
          tx,
          context,
          principal,
          input,
          this.projects,
          this.importDeps,
        );
        results = done.results;
        notion = done.summary;
      } else {
        const done = await commitBasecampBatch(
          tx,
          context,
          principal,
          input,
          this.projects,
          this.importDeps,
        );
        results = done.results;
        basecamp = done.summary;
      }
      const written: ImportCommitRowView[] = [];
      for (const result of results) {
        if ('error' in result) {
          written.push(
            await this.recordFailure(tx, context, request.jobId, result.index, result.error),
          );
          continue;
        }
        await this.rows.create(tx, context, {
          jobId: request.jobId,
          sourceIndex: result.index,
          outcome: 'created',
          createdEntityId: result.createdEntityId,
          entityType: result.entityType,
        });
        written.push({
          sourceIndex: result.index,
          outcome: 'created',
          createdEntityId: result.createdEntityId,
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
      return { written, committedCount, failedCount, status, notion, basecamp, board };
    });

    return {
      jobId: request.jobId,
      sourceKind: request.sourceKind,
      status: outcome.status,
      committedCount: outcome.committedCount,
      failedCount: outcome.failedCount,
      rows: outcome.written,
      ...(outcome.notion === undefined ? {} : { notion: outcome.notion }),
      ...(outcome.basecamp === undefined ? {} : { basecamp: outcome.basecamp }),
      ...(outcome.board === undefined ? {} : { board: outcome.board }),
    };
  }

  /**
   * R23-e (54-24) — undo a committed job inside its 7-day window: every `created` document and
   * work item is soft-deleted (`deleted_reason 'import_undo'`, restorable until the content purge)
   * and every created phase definition is removed, in one transaction with the job's undo stamp
   * and an `import.undo` audit row (counts only).
   *
   * Order: the job is resolved tenant-scoped first (404 for a missing / foreign id, or one with no
   * receipt yet); then the state checks (409 `import_undo_done`, `import_undo_window`,
   * `import_undo_unsupported` — a `project` row, or a row written before 0316 with no type); then,
   * inside the transaction, the object-layer `project.manage` `authorize()` on every project the
   * created entities live in (the capability the commit's phase and key steps check; `project.update`
   * is not a capability here) — one denial is a 403 before any write. Created labels (Jira epics)
   * are left in place (54-24 deletes labels only "that nothing else uses"; not built, stated).
   */
  async undo(context: TenantContext, principal: Principal, jobId: string): Promise<ImportUndoView> {
    const found = await this.database.read(context, async (runner) => {
      const job = await this.jobs.findById(runner, context, jobId);
      if (!job) return null;
      const rows = await this.rows.listByJob(runner, context, jobId);
      return { job, rows };
    });
    if (!found || !COMMITTED_STATUSES.has(found.job.status)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'import_job_not_visible');
    }
    const { job, rows } = found;
    if (job.undoneAt !== null) {
      throw undoConflict('This import was already undone', 'import_undo_done');
    }
    const committedAt = job.committedAt?.getTime() ?? 0;
    if (this.importDeps.now().getTime() - committedAt > IMPORT_UNDO_WINDOW_MS) {
      throw undoConflict('The undo window for this import has closed', 'import_undo_window');
    }
    const created = rows.filter((row) => row.outcome === 'created');
    if (created.some((row) => row.entityType === null || row.entityType === 'project')) {
      throw undoConflict('This kind of import cannot be undone', 'import_undo_unsupported');
    }
    const targets: ImportedEntity[] = created.flatMap((row) =>
      row.createdEntityId !== null && row.entityType !== null && UNDOABLE_TYPES.has(row.entityType)
        ? [{ type: row.entityType as ImportedEntityType, id: row.createdEntityId }]
        : [],
    );

    const stamped = await this.database.transaction(context, async (tx) => {
      const located = await this.undoRepository.locate(tx, context, targets);
      for (const projectId of new Set(located.map((entity) => entity.projectId))) {
        const project = await this.projects.findById(tx, context, projectId);
        if (!project) continue;
        const verdict = authorize({
          principal,
          capability: 'project.manage',
          resource: {
            organizationId: context.organizationId,
            projectId: project.id,
            audience: 'internal',
            lifecycle: project.archivedAt === null ? 'active' : 'archived',
          },
        });
        if (!verdict.allowed) {
          throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, verdict.code);
        }
      }
      const { deleted } = await undoImportedEntities(tx, context, located, this.undoDeps);
      let row;
      try {
        row = await this.jobs.markUndone(tx, context, jobId, {
          undoneByUserId: context.userId,
          undoneCount: deleted,
        });
      } catch (error) {
        if (error instanceof ImportJobAlreadyUndoneError) {
          throw undoConflict('This import was already undone', 'import_undo_done');
        }
        throw error;
      }
      await this.audit.append(tx, context, {
        action: 'import.undo',
        result: 'allowed',
        objectId: jobId,
        metadata: { job_id: jobId, source_kind: job.sourceKind, deleted },
      });
      return { deleted, undoneAt: row.undoneAt ?? new Date() };
    });

    return { jobId, deleted: stamped.deleted, undoneAt: stamped.undoneAt.toISOString() };
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

/** A compact, column-bounded summary of a row's field errors for the receipt. */
function summarizeRowError(error: RowValidationError): string {
  return error.errors.map((f) => `${f.field}: ${f.message}`).join('; ');
}

function undoConflict(message: string, code: string): ApiError {
  // The code travels in `details` (the fifth argument is logged, never serialised) so the import
  // web can translate it.
  return new ApiError(409, 'conflict', message, [{ field: 'jobId', message: code }], code);
}

/** The receipt's `undoAvailableUntil`: commit + 7 days while undoable, else `null`. */
function undoAvailableUntil(
  job: {
    readonly committedAt: Date | null;
    readonly undoneAt: Date | null;
  },
  rows: readonly { readonly outcome: string; readonly entityType: string | null }[],
  now: number,
): string | null {
  if (job.committedAt === null || job.undoneAt !== null) return null;
  const until = job.committedAt.getTime() + IMPORT_UNDO_WINDOW_MS;
  if (until < now) return null;
  const unsupported = rows.some(
    (row) => row.outcome === 'created' && (row.entityType === null || row.entityType === 'project'),
  );
  return unsupported ? null : new Date(until).toISOString();
}

/** R31 (A11) — one `import_jobs` row as a history entry (see {@link ImportJobSummaryView}). */
export function importJobSummary(
  job: {
    readonly id: string;
    readonly sourceKind: string;
    readonly status: string;
    readonly totalCount: number;
    readonly committedCount: number | null;
    readonly failedCount: number | null;
    readonly createdAt: Date;
    readonly committedAt: Date | null;
    readonly undoneAt: Date | null;
  },
  now: number,
): ImportJobSummaryView {
  return {
    jobId: job.id,
    sourceKind: job.sourceKind as ImportSourceKind,
    status: job.status === 'committed' ? 'committed' : 'committed_with_errors',
    totalCount: job.totalCount,
    committedCount: job.committedCount ?? 0,
    failedCount: job.failedCount ?? 0,
    createdAt: job.createdAt.toISOString(),
    committedAt: job.committedAt === null ? null : job.committedAt.toISOString(),
    undoneAt: job.undoneAt === null ? null : job.undoneAt.toISOString(),
    undoAvailableUntil: job.sourceKind === 'project' ? null : undoAvailableUntil(job, [], now),
  };
}
