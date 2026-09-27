import { Body, Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { TENANT_DATABASE, WORKFLOW_TEMPLATES_REPOSITORY } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkflowTemplateConfig, WorkflowTemplateRow } from '../../common/database/schema.js';
import type { WorkflowTemplatesRepository } from './templates.repository.js';

/**
 * Automations & integrations (module 17, x219). One endpoint: **clone an existing workflow template**
 * — the lifecycle step the define/list (x162) and edit (x189) slices left open. An admin could define
 * a template, list it and re-tune it, but never duplicate one as the starting point for a variant. A
 * distinct file and controller from both, on the same route base.
 *
 * ## The capability
 *
 * Cloning an automation is the same org-admin concern as defining one, so this reuses `org.manage`
 * exactly as x162/x189 do — no `automation.*` capability exists and this slice adds none. The route
 * guard (`@RequireCapability`) asks the coarse ceiling question; this controller adds the
 * authoritative org-scoped application decision (`25-AUTH` §3 step 2, deny-by-default) the guard
 * cannot — an `authorize()` with `projectId: null` that a suspended membership fails.
 *
 * ## The Known-trap order — tenant-scope the source id BEFORE authorize/write
 *
 * This is an id-named route, so the classic trap is trusting the `:id`. The **source** template is
 * resolved by the composite tenant key `(organization_id, id)` *first*: an unknown or cross-tenant id
 * is a 404 (`workflow_template_not_found`) with nothing authorized and nothing written — the id is
 * never trusted alone, and existence never leaks across tenants. Only then is the org-scoped
 * `org.manage` decision made (403 on a denied but existing template), and only then is the body's new
 * name validated (400) and the collision checked (409).
 *
 * ## What a clone is, and is not
 *
 * The clone copies only the source's *behaviour* — `triggerKind`, `actionKind` and `config` — into a
 * brand-new row under a caller-supplied name. It does **not** copy the source's identity: `id`,
 * `organization_id` and `created_by` are generated fresh (the `BEFORE UPDATE` trigger, `0063`, keeps a
 * template's identity immutable, so a clone is an insert, never a re-id of the source). The clone
 * starts **disabled** regardless of the source's `enabled` state — a duplicated automation must never
 * silently begin firing the moment it is created; enabling it is a deliberate later edit (x189). The
 * source row is left untouched. `workflow_templates` has no unique-name constraint, so a name that
 * already exists in the tenant is a 409 (`workflow_template_name_conflict`) with no insert; the
 * collision check and the insert run in one transaction. No egress, no execution.
 */

/** `workflow_templates.name` is `VARCHAR(300)`. */
const MAX_NAME_LENGTH = 300;

/**
 * What a caller is allowed to see of the cloned template. Structurally identical to the define/list
 * `WorkflowTemplateView` and the edit `WorkflowTemplateEditView`, and paired Exact with its own web
 * shape in the contracts gate so the clone response is checked in its own right. `organizationId` is
 * deliberately absent — the wire projection never echoes the tenant id.
 */
export interface TemplateCloneView {
  readonly id: string;
  readonly name: string;
  readonly triggerKind: string;
  readonly actionKind: string;
  readonly config: WorkflowTemplateConfig;
  readonly enabled: boolean;
  readonly createdBy: string;
  /** An ISO-8601 instant. */
  readonly createdAt: string;
}

/** An explicit projection, not a serialised row: a column added later is invisible until named. */
function toCloneView(row: WorkflowTemplateRow): TemplateCloneView {
  return {
    id: row.id,
    name: row.name,
    triggerKind: row.triggerKind,
    actionKind: row.actionKind,
    config: row.configJson,
    enabled: row.enabled,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

interface CloneTemplateBody {
  readonly name?: unknown;
}

@Controller('v1/organizations/:orgSlug/automations/templates')
export class WorkflowTemplateCloneController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(WORKFLOW_TEMPLATES_REPOSITORY) private readonly templates: WorkflowTemplatesRepository,
  ) {}

  /**
   * Clone one workflow template. `org.manage`, relation-gated org-scoped. Resolve the source by
   * `(organization_id, id)` first (404), then authorize (403), then validate the new name (400), then
   * — in one transaction — reject a name collision (409) and insert the disabled copy.
   */
  @Post(':id/clone')
  @RequireCapability('org.manage')
  @HttpCode(201)
  async clone(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body() body: CloneTemplateBody,
  ): Promise<TemplateCloneView> {
    // 1. Tenant-scope the source id BEFORE authorize/write: unknown or cross-tenant → 404, nothing leaked.
    const source = await this.database.read(context, (runner) =>
      this.templates.findById(runner, context, id),
    );
    if (!source) {
      throw new ApiError(
        404,
        'not_found',
        MESSAGES.notFound,
        undefined,
        'workflow_template_not_found',
      );
    }

    // 2. The authoritative org-scoped decision the route guard cannot make.
    if (!this.mayManageOrg(principal, context)) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'workflow_template_clone_denied',
      );
    }

    // 3. Validate the caller-supplied name; an empty or over-long name is a 400 with no write.
    const name = validateName(body?.name);

    // 4. In one transaction: a duplicate name is a 409, else insert a fresh, DISABLED copy of the
    //    source's behaviour. Identity (id, organization_id, created_by) is generated new by the
    //    repository, never carried from the source.
    const row = await this.database.transaction(context, async (tx) => {
      const existing = await this.templates.findByName(tx, context, name);
      if (existing) {
        throw new ApiError(
          409,
          'conflict',
          'A template with that name already exists',
          [{ field: 'name', message: 'must be unique within the organization' }],
          'workflow_template_name_conflict',
        );
      }
      return this.templates.create(tx, context, {
        name,
        triggerKind: source.triggerKind,
        actionKind: source.actionKind,
        config: source.configJson,
        // A clone never auto-runs: it starts disabled regardless of the source's state.
        enabled: false,
        // The clone is authored by the caller, not the source's author.
        createdBy: context.userId,
      });
    });
    return toCloneView(row);
  }

  /** Org-scoped deny-by-default decision the route guard cannot make (membership status, etc.). */
  private mayManageOrg(principal: Principal, context: TenantContext): boolean {
    return authorize({
      principal,
      capability: 'org.manage',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
  }
}

function validateName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name === '') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'name', message: 'must be a non-empty string' },
    ]);
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'name', message: `must be ${MAX_NAME_LENGTH} characters or fewer` },
    ]);
  }
  return name;
}
