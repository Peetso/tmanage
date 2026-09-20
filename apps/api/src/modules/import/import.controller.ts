import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { Ctx, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { IMPORT_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { parseImportValidationBody } from './import-input.js';
import type { ImportService, ImportValidationView } from './import.service.js';

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
}
