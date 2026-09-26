import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { IMPORT_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { parseImportCommitBody, parseImportValidationBody } from './import-input.js';
import type { ImportCommitView, ImportService, ImportValidationView } from './import.service.js';

/**
 * ON-09 / ADM-10 — the onboarding-import validate / dry-run endpoint.
 *
 * One route this slice: `POST …/imports/validations` accepts a source mapping and a batch of
 * source rows, validates them against the target shape, persists the attempt as one
 * `import_jobs` row and returns the report plus that job id. It **commits no target entity**.
 *
 * ## Capability
 *
 * Reused, not new: `org.manage`. `41 §ADM-10` places data import/export under **Admin**, so
 * import is an org-level administrative action (owner / org_admin), and the coarse gate is the
 * same one `ClientsController` uses. A dedicated `import.run` capability is the clean follow-up,
 * but adding it would edit `capabilities.ts` + `role-operation-grid.ts` and serialize with the
 * grid slices — deliberately deferred (NEXT-SCOPES-5 §Item x95).
 *
 * Like every tenant-scoped controller here, it reads `organization_id` from the `TenantContext`
 * the guard built, never from the body or the `:orgSlug` path segment.
 *
 * `200`, not `201`: the addressable result is a validation *report*, and validate-only creates
 * no resource a client navigates to. The `import_jobs` row is an internal anchor, its id
 * returned inside the report rather than as a `Location`.
 */

interface ImportValidationRequestBody {
  readonly sourceKind?: unknown;
  readonly mapping?: unknown;
  readonly rows?: unknown;
}

interface ImportCommitRequestBody extends ImportValidationRequestBody {
  readonly jobId?: unknown;
}

@Controller('v1/organizations/:orgSlug/imports')
export class ImportController {
  constructor(@Inject(IMPORT_SERVICE) private readonly imports: ImportService) {}

  @Post('validations')
  @RequireCapability('org.manage')
  @HttpCode(200)
  async validate(
    @Ctx() context: TenantContext,
    @Body() body: ImportValidationRequestBody,
  ): Promise<ImportValidationView> {
    const details: { field: string; message: string }[] = [];
    const request = parseImportValidationBody(body, details);
    if (!request || details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.imports.validate(context, request);
  }

  /**
   * `POST …/imports/commits` — the commit half. Takes the id of a validated job plus the batch
   * to commit, re-validates it, creates the target entities from the rows that pass (each through
   * the object-layer `project.create` `authorize()`), records a per-row receipt, and transitions
   * the job to a terminal `committed` / `committed_with_errors` status.
   *
   * ## Capability
   *
   * Reused, not new: `org.manage`, the same coarse gate as the validate half — `41 §ADM-10`
   * places data import under Admin. The per-row `project.create` `authorize()` in the service is
   * what keeps a commit no broader than a manual create; adding a dedicated `import.run`
   * capability would edit `capabilities.ts` + `role-operation-grid.ts` and is the deferred
   * follow-up (recorded in `docs/implementation-status.md`).
   *
   * `200`, not `201`: partial failure means the addressable result is a *receipt* describing what
   * happened to each row, not a single created resource a `Location` would point at. The created
   * entities are addressable at their own routes; their ids are in the receipt.
   */
  @Post('commits')
  @RequireCapability('org.manage')
  @HttpCode(200)
  async commit(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: ImportCommitRequestBody,
  ): Promise<ImportCommitView> {
    const details: { field: string; message: string }[] = [];
    const request = parseImportCommitBody(body, details);
    if (!request || details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.imports.commit(context, principal, request);
  }

  /**
   * `GET …/imports/:jobId/receipt` — the receipt read half (ON-09 "progress" / ADM-10 "receipt",
   * x104). Returns a committed job's terminal status, its committed / failed counts, and the
   * per-row `import_rows` outcomes in source order. Pure read: it commits and re-runs nothing.
   *
   * ## Capability
   *
   * Reused, not new: `org.manage`, the same coarse gate the validate and commit halves use —
   * `41 §ADM-10` places data import under Admin. A caller without it is refused by the guard
   * exactly as the sibling import routes refuse, before this handler runs.
   *
   * ## Tenant-scoped resolve before anything else
   *
   * The job is named by id in the path. `ImportService.getReceipt` loads it tenant-scoped first,
   * so a missing or cross-tenant id is a **404**, never a 500 and never a foreign receipt — the
   * same discipline the commit half's job load follows. The `:orgSlug` segment is the claim the
   * guard resolves against a membership; it is never read here.
   */
  @Get(':jobId/receipt')
  @RequireCapability('org.manage')
  async receipt(
    @Ctx() context: TenantContext,
    @Param('jobId') jobId: string,
  ): Promise<ImportCommitView> {
    return this.imports.getReceipt(context, jobId);
  }
}
