import { Body, Controller, Inject, Param, Patch } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { TENANT_DATABASE, WORKFLOW_TEMPLATES_REPOSITORY } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkflowTemplateConfig, WorkflowTemplateRow } from '../../common/database/schema.js';
import type {
  UpdateWorkflowTemplateInput,
  WorkflowTemplatesRepository,
} from './templates.repository.js';
import { WORKFLOW_ACTION_KINDS, WORKFLOW_TRIGGER_KINDS } from './templates.controller.js';
import type { WorkflowActionKind, WorkflowTriggerKind } from './templates.controller.js';

/**
 * Automations & integrations (module 17, x189). One endpoint: **edit an existing workflow template**
 * — the lifecycle step the create-only x162 slice left open (an admin could define a template and
 * list it, but never rename it, re-point its trigger/action, or re-tune its config). A distinct file
 * and controller from the define/list one, on the same route base.
 *
 * ## The capability
 *
 * Editing an automation is the same org-admin concern as defining one, so this reuses `org.manage`
 * exactly as x162 does — no `automation.*` capability exists and this slice adds none. The route
 * guard (`@RequireCapability`) asks the coarse ceiling question; this controller adds the
 * authoritative org-scoped application decision (`25-AUTH` §3 step 2, deny-by-default) the guard
 * cannot — an `authorize()` with `projectId: null` that a suspended membership fails.
 *
 * ## The Known-trap order — tenant-scope the id BEFORE authorize/mutate
 *
 * This is an id-named route, so the classic trap is trusting the id. The template is resolved by the
 * **composite tenant key** `(organization_id, id)` *first*: an unknown or cross-tenant id is a 404
 * (`workflow_template_not_found`) with nothing authorized and nothing written — the id is never
 * trusted alone, and existence never leaks across tenants. Only then is the org-scoped `org.manage`
 * decision made (403 on a denied but existing template), and only then is the body validated (a 400
 * for an off-list trigger/action or an over-size config, decided before the write). The repository's
 * `UPDATE` also carries the tenant predicate, so the isolation holds even if the resolve were
 * skipped.
 *
 * ## What this slice does not do
 *
 * `workflow_templates` has no archive/status column and this is a no-migration slice, so the archive
 * control the scope contemplated is deferred (it needs a column, hence a migration, hence a later
 * slice); a template's identity (`organization_id`, `created_by`) stays immutable at the engine.
 * Enabling/disabling rides on the same edit as the `enabled` field.
 */

/** `workflow_templates.name` is `VARCHAR(300)`. */
const MAX_NAME_LENGTH = 300;
/** The serialised-config bound, identical to the create path so an edit cannot smuggle a larger config. */
const MAX_CONFIG_BYTES = 4000;

/**
 * What a caller is allowed to see of the edited template. Structurally identical to the define/list
 * `WorkflowTemplateView`, and paired Exact with its own web shape in the contracts gate so the edit
 * response is checked in its own right. `organizationId` is deliberately absent — the wire projection
 * never echoes the tenant id.
 */
export interface WorkflowTemplateEditView {
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
function toEditView(row: WorkflowTemplateRow): WorkflowTemplateEditView {
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

interface EditTemplateBody {
  readonly name?: unknown;
  readonly triggerKind?: unknown;
  readonly actionKind?: unknown;
  readonly config?: unknown;
  readonly enabled?: unknown;
}

@Controller('v1/organizations/:orgSlug/automations/templates')
export class WorkflowTemplateEditController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(WORKFLOW_TEMPLATES_REPOSITORY) private readonly templates: WorkflowTemplatesRepository,
  ) {}

  /**
   * Edit one workflow template. `org.manage`, relation-gated org-scoped. Resolve by
   * `(organization_id, id)` first (404), then authorize (403), then validate the partial body (400),
   * then write. A body with no editable field is a 400 — there is nothing to change.
   */
  @Patch(':id')
  @RequireCapability('org.manage')
  async update(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body() body: EditTemplateBody,
  ): Promise<WorkflowTemplateEditView> {
    // 1. Tenant-scope the id BEFORE authorize/mutate: unknown or cross-tenant → 404, nothing leaked.
    const existing = await this.database.read(context, (runner) =>
      this.templates.findById(runner, context, id),
    );
    if (!existing) {
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
        'workflow_template_edit_denied',
      );
    }

    // 3. Validate only the fields present; an off-list or over-size value is a 400 with no write.
    const patch = validatePatch(body);

    // 4. Write within the acting tenant and return exactly what the engine holds.
    const row = await this.database.transaction(context, (tx) =>
      this.templates.update(tx, context, id, patch),
    );
    if (!row) {
      // The row was resolved above; a null here means it was removed concurrently. Treat as gone.
      throw new ApiError(
        404,
        'not_found',
        MESSAGES.notFound,
        undefined,
        'workflow_template_not_found',
      );
    }
    return toEditView(row);
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

/**
 * A partial edit: only the fields present are validated and written, and at least one editable field
 * must be present. Identity fields are not accepted at all — the body shape has no `organizationId`
 * or `createdBy`.
 */
function validatePatch(body: EditTemplateBody): UpdateWorkflowTemplateInput {
  const patch: {
    name?: string;
    triggerKind?: WorkflowTriggerKind;
    actionKind?: WorkflowActionKind;
    config?: WorkflowTemplateConfig;
    enabled?: boolean;
  } = {};

  if (body?.name !== undefined) patch.name = validateName(body.name);
  if (body?.triggerKind !== undefined) patch.triggerKind = validateTriggerKind(body.triggerKind);
  if (body?.actionKind !== undefined) patch.actionKind = validateActionKind(body.actionKind);
  if (body?.config !== undefined) patch.config = validateConfig(body.config);
  if (body?.enabled !== undefined) patch.enabled = validateEnabled(body.enabled);

  if (Object.keys(patch).length === 0) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'body', message: 'at least one editable field must be provided' },
    ]);
  }
  return patch;
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

function validateTriggerKind(raw: unknown): WorkflowTriggerKind {
  if (!isTriggerKind(raw)) {
    throw new ApiError(
      400,
      'validation_failed',
      'The request body is invalid',
      [{ field: 'triggerKind', message: `must be one of ${WORKFLOW_TRIGGER_KINDS.join(', ')}` }],
      'workflow_template_trigger_off_list',
    );
  }
  return raw;
}

function validateActionKind(raw: unknown): WorkflowActionKind {
  if (!isActionKind(raw)) {
    throw new ApiError(
      400,
      'validation_failed',
      'The request body is invalid',
      [{ field: 'actionKind', message: `must be one of ${WORKFLOW_ACTION_KINDS.join(', ')}` }],
      'workflow_template_action_off_list',
    );
  }
  return raw;
}

function validateConfig(raw: unknown): WorkflowTemplateConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'config', message: 'must be an object' },
    ]);
  }
  const serialised = JSON.stringify(raw);
  if (serialised.length > MAX_CONFIG_BYTES) {
    throw new ApiError(
      400,
      'validation_failed',
      'The request body is invalid',
      [{ field: 'config', message: `must serialise to ${MAX_CONFIG_BYTES} characters or fewer` }],
      'workflow_template_config_too_large',
    );
  }
  validateRuleOptions(raw as Record<string, unknown>);
  return raw as WorkflowTemplateConfig;
}

/** A14: who else a reminder tells. `none` (or the key absent) tells the owner only. */
export const ALSO_TELL_OPTIONS = ['project_lead', 'none'] as const;

/**
 * A14 — the two rule options the rule page edits live in `config`: `skipWeekends` (a boolean the
 * worker honours) and `alsoTell` (an allowlisted token). Absent is fine; a present but wrong-typed
 * or off-list value is a 400 with nothing written.
 */
function validateRuleOptions(config: Record<string, unknown>): void {
  if (config['skipWeekends'] !== undefined && typeof config['skipWeekends'] !== 'boolean') {
    throw new ApiError(
      400,
      'validation_failed',
      'The request body is invalid',
      [{ field: 'config.skipWeekends', message: 'must be a boolean' }],
      'workflow_template_skip_weekends_invalid',
    );
  }
  const alsoTell = config['alsoTell'];
  if (
    alsoTell !== undefined &&
    !(typeof alsoTell === 'string' && (ALSO_TELL_OPTIONS as readonly string[]).includes(alsoTell))
  ) {
    throw new ApiError(
      400,
      'validation_failed',
      'The request body is invalid',
      [{ field: 'config.alsoTell', message: `must be one of ${ALSO_TELL_OPTIONS.join(', ')}` }],
      'workflow_template_also_tell_off_list',
    );
  }
}

function validateEnabled(raw: unknown): boolean {
  if (typeof raw !== 'boolean') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'enabled', message: 'must be a boolean' },
    ]);
  }
  return raw;
}

function isTriggerKind(value: unknown): value is WorkflowTriggerKind {
  return typeof value === 'string' && (WORKFLOW_TRIGGER_KINDS as readonly string[]).includes(value);
}

function isActionKind(value: unknown): value is WorkflowActionKind {
  return typeof value === 'string' && (WORKFLOW_ACTION_KINDS as readonly string[]).includes(value);
}
