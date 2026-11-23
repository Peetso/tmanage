import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Optional,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import {
  AUDIT_SERVICE,
  TENANT_DATABASE,
  WORK_FORMS_REPOSITORY,
  WORK_ITEMS_SERVICE,
} from '../../common/http/tokens.js';
import type { AuditService } from '../audit/audit.service.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkFormFieldDef, WorkFormRow } from '../../common/database/schema.js';
import type { WorkFormsRepository } from './work-forms.repository.js';
import type { WorkItemsService, WorkItemView } from './work-items.service.js';
import {
  submissionAnswersDescription,
  validateFieldDefs,
  validateFormName,
  validateSubmissionValues,
} from './work-forms.validate.js';

/**
 * WORK intake forms (module 7, x146). Three endpoints: define a reusable intake form, list the
 * organization's forms, and submit a form to create a work item.
 *
 * ## The two authorization layers
 *
 * `CapabilityGuard` on each route asks the coarse `work.read` / `work.create` question — does this
 * role's ceiling include the capability at all. This controller adds the authoritative application
 * decision (`25-AUTH` §3 step 2, deny-by-default) that the guard cannot: for the org-scoped
 * define/list, an org-scoped `authorize()` (`projectId: null`) that a suspended membership fails,
 * exactly as `DocumentsService.createTemplate`/`listTemplates` do; for a submission, the relation
 * gate is the existing work service's `create`, reused verbatim (no new work path).
 *
 * ## The Known-trap order (submissions)
 *
 * A submission names a form by id in the path. That id is resolved **tenant-scoped first**, so an
 * unknown or cross-tenant `formId` is a 404 with no write, before any validation or work-item
 * create. The payload is then validated against the form's fields — an invalid payload is a 400 with
 * no work item — and only then is the work item created through {@link WorkItemsService.create},
 * which resolves the named project tenant-scoped and relation-gates `work.create` (a non-member is
 * 404, never 403). A form never echoes `organization_id`.
 */

/** What a caller is allowed to see of one work form. `organizationId` is deliberately absent. */
export interface WorkFormView {
  readonly id: string;
  readonly name: string;
  readonly fields: readonly WorkFormFieldDef[];
  readonly createdBy: string;
  /** An ISO-8601 instant. */
  readonly createdAt: string;
  /** 2026-10-31 live-test fix: whether the form has a live public link (`/f/<publicSlug>`). */
  readonly published: boolean;
  /** The public link's slug while published; `null` when the form is not shared. */
  readonly publicSlug: string | null;
  /**
   * 52-20a. The project visitors' files are kept in, or `null` when the form takes no files. Team
   * view only: the public form response (`PublicFormView`) never names a project.
   */
  readonly attachmentProjectId: string | null;
}

/** An explicit projection, not a serialised row: a column added later is invisible until named. */
function toView(row: WorkFormRow): WorkFormView {
  return {
    id: row.id,
    name: row.name,
    fields: row.fieldsJson,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    published: row.publicEnabled === true && row.publicSlug !== null,
    publicSlug: row.publicEnabled === true ? row.publicSlug : null,
    attachmentProjectId: row.attachmentProjectId,
  };
}

interface CreateWorkFormBody {
  readonly name?: unknown;
  readonly fields?: unknown;
}

interface CreateSubmissionBody {
  readonly projectId?: unknown;
  readonly title?: unknown;
  readonly values?: unknown;
}

@Controller('v1/organizations/:orgSlug/work-forms')
export class WorkFormsController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(WORK_FORMS_REPOSITORY) private readonly forms: WorkFormsRepository,
    @Inject(WORK_ITEMS_SERVICE) private readonly workItems: WorkItemsService,
    // Fix lane C: optional so a unit test can build the controller without an audit writer.
    @Optional() @Inject(AUDIT_SERVICE) private readonly audit?: Pick<AuditService, 'record'>,
  ) {}

  /**
   * List the acting tenant's work forms, name-ascending, for a caller who may read. `work.read`,
   * relation-gated org-scoped (`projectId: null`, so every active member may read its forms).
   */
  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('limit') limit?: string,
  ): Promise<{ readonly forms: readonly WorkFormView[] }> {
    if (!this.mayActOrg(principal, context, 'work.read')) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'work_form_read_denied');
    }

    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && !Number.isSafeInteger(parsedLimit)) {
      throw new ApiError(400, 'validation_failed', 'limit must be an integer', [
        { field: 'limit', message: 'must be an integer' },
      ]);
    }

    const rows = await this.database.read(context, (runner) =>
      this.forms.list(runner, context, parsedLimit !== undefined ? { limit: parsedLimit } : {}),
    );
    return { forms: rows.map(toView) };
  }

  /**
   * Define a work form. `work.create`, relation-gated org-scoped: a denial is a 403 — there is no
   * object to hide on a create, so the not-found masking a submission uses does not apply here.
   */
  @Post()
  @RequireCapability('work.create')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateWorkFormBody,
  ): Promise<WorkFormView> {
    if (!this.mayActOrg(principal, context, 'work.create')) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'work_form_write_denied');
    }

    const name = validateFormName(body?.name);
    const fields = validateFieldDefs(body?.fields);

    const row = await this.database.transaction(context, (tx) =>
      this.forms.create(tx, context, { name, fields, createdBy: context.userId }),
    );
    return toView(row);
  }

  /**
   * Submit a form: validate a payload against its fields, then create a work item.
   *
   * `formId` is resolved tenant-scoped BEFORE anything else (Known-trap): an unknown or cross-tenant
   * id is a 404 with no write. The payload is validated against the form's fields (invalid → 400, no
   * work item). The work item is then created through the existing work service, which resolves the
   * project and relation-gates `work.create`. The response is the created work item.
   */
  @Post(':formId/submissions')
  @RequireCapability('work.create')
  @HttpCode(201)
  async submit(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('formId') formId: string,
    @Body() body: CreateSubmissionBody,
  ): Promise<WorkItemView> {
    if (typeof formId !== 'string' || formId === '') {
      throw new ApiError(400, 'validation_failed', 'formId is required', [
        { field: 'formId', message: 'must be a non-empty string' },
      ]);
    }

    // Known-trap: resolve the form tenant-scoped first. Unknown / cross-tenant ⇒ 404, no write.
    const form = await this.database.read(context, (runner) =>
      this.forms.findById(runner, context, formId),
    );
    if (!form) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'work_form_not_visible');
    }

    const projectId = typeof body?.projectId === 'string' ? body.projectId : '';
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    const submissionDetails = [
      ...(projectId === '' ? [{ field: 'projectId', message: 'must be a non-empty string' }] : []),
      ...(title === '' ? [{ field: 'title', message: 'must be a non-empty string' }] : []),
    ];
    if (submissionDetails.length > 0) {
      throw new ApiError(
        400,
        'validation_failed',
        'The request body is invalid',
        submissionDetails,
      );
    }

    // Payload validated against the form's fields before any work item is created.
    validateSubmissionValues(form.fieldsJson, body?.values);

    // No new work path: the existing service resolves the project tenant-scoped and relation-gates
    // `work.create` (a non-member is 404, never 403), then creates and audits the work item.
    // 2026-10-31 live-test fix: the answers were validated and then dropped; keep them on the item.
    const description = submissionAnswersDescription(form.fieldsJson, body?.values);
    return this.workItems.create(context, principal, { projectId, title, description });
  }

  /** Org-scoped deny-by-default decision the route guard cannot make (membership status, etc.). */
  /**
   * Fix lane C (2026-11-23). Delete a form. `work.create` (as create, publish and unpublish), and
   * only the person who made it or an owner/admin (`org.manage`). A published form is 409
   * `form_published` (unpublish it first) and a form with submissions is 409
   * `form_has_submissions` (the requests keep their source); an unknown id is 404.
   */
  @Delete(':formId')
  @RequireCapability('work.create')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('formId') formId: string,
  ): Promise<void> {
    await this.database.transaction(context, async (tx) => {
      const form = await this.forms.findById(tx, context, formId);
      if (!form || !this.mayActOrg(principal, context, 'work.read')) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'work_form_not_found');
      }
      const isAdmin = authorize({
        principal,
        capability: 'org.manage',
        resource: {
          organizationId: context.organizationId,
          projectId: null,
          audience: 'internal',
          lifecycle: 'active',
        },
      }).allowed;
      if (
        !this.mayActOrg(principal, context, 'work.create') ||
        (form.createdBy !== context.userId && !isAdmin)
      ) {
        throw new ApiError(
          403,
          'forbidden',
          MESSAGES.forbidden,
          undefined,
          'work_form_write_denied',
        );
      }
      if (form.publicEnabled) {
        throw new ApiError(409, 'conflict', 'Unpublish this form before you delete it.', [
          { field: 'formId', message: 'form_published' },
        ]);
      }
      if (await this.forms.hasSubmissions(tx, context, form.id)) {
        throw new ApiError(
          409,
          'conflict',
          'This form has submissions, so it is kept. Unpublish it to stop new ones.',
          [{ field: 'formId', message: 'form_has_submissions' }],
        );
      }
      await this.audit?.record(tx, context, {
        action: 'work_form.deleted',
        objectId: form.id,
        result: 'allowed',
        metadata: {},
      });
      await this.forms.delete(tx, context, form.id);
    });
  }

  private mayActOrg(
    principal: Principal,
    context: TenantContext,
    capability: 'work.read' | 'work.create',
  ): boolean {
    return authorize({
      principal,
      capability,
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
  }
}
