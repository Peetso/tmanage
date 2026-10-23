import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { TENANT_DATABASE, WORKFLOW_TEMPLATES_REPOSITORY } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkflowTemplateConfig, WorkflowTemplateRow } from '../../common/database/schema.js';
import { isRowLockedError, type WorkflowTemplatesRepository } from './templates.repository.js';

/**
 * Automations & integrations (module 17, x162). Two endpoints: define a workflow template and list
 * the organization's templates.
 *
 * ## The capability
 *
 * Automations are an org-admin concern, so both routes reuse `org.manage` — no `automation.*`
 * capability exists and this slice adds none. `CapabilityGuard` asks the coarse ceiling question;
 * this controller adds the authoritative application decision (`25-AUTH` §3 step 2, deny-by-default)
 * the guard cannot: an org-scoped `authorize()` (`projectId: null`) that a suspended membership fails,
 * exactly as the client-organization admin reads do.
 *
 * ## The Known-trap order
 *
 * The tenant is resolved by `TenantContextGuard` (which runs before this controller) and read from
 * the context, never from the body — so a create writes into the acting tenant and nowhere else, and
 * a list is org-scoped by the repository, which makes a cross-tenant read impossible. The `org.manage`
 * decision is made **before** any write. An off-list `triggerKind`/`actionKind` or an over-size
 * `config` is a 400 with no write, decided before the repository is touched.
 *
 * Execution/runs are x163: this slice only records what an automation *would* do.
 */

/**
 * The fixed allowlist of events an automation may trigger on. A value outside this set is a 400
 * (`workflow_template_trigger_off_list`), never stored. Kept in the application (not a DB `ENUM`) so
 * the set can grow without a schema change; the column only ever holds a token from here.
 */
export const WORKFLOW_TRIGGER_KINDS = [
  'work_item_created',
  'work_item_transitioned',
  'request_submitted',
  'meeting_scheduled',
  'document_published',
] as const;
export type WorkflowTriggerKind = (typeof WORKFLOW_TRIGGER_KINDS)[number];

/**
 * The fixed allowlist of actions an automation may take. A value outside this set is a 400
 * (`workflow_template_action_off_list`), never stored.
 */
export const WORKFLOW_ACTION_KINDS = [
  'notify_owner',
  'create_work_item',
  'post_message',
  'send_email_digest',
] as const;
export type WorkflowActionKind = (typeof WORKFLOW_ACTION_KINDS)[number];

/** `workflow_templates.name` is `VARCHAR(300)`. */
const MAX_NAME_LENGTH = 300;
/**
 * A guard on the config size — an action config is a small object, not an unbounded document. The
 * bound is on the serialised JSON so a deeply nested payload cannot slip past a key count.
 */
const MAX_CONFIG_BYTES = 4000;

const MAX_PAGE_SIZE = 200;

/** What a caller is allowed to see of one workflow template. `organizationId` is deliberately absent. */
export interface WorkflowTemplateView {
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
function toView(row: WorkflowTemplateRow): WorkflowTemplateView {
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

interface CreateTemplateBody {
  readonly name?: unknown;
  readonly triggerKind?: unknown;
  readonly actionKind?: unknown;
  readonly config?: unknown;
  readonly enabled?: unknown;
}

@Controller('v1/organizations/:orgSlug/automations/templates')
export class WorkflowTemplatesController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(WORKFLOW_TEMPLATES_REPOSITORY) private readonly templates: WorkflowTemplatesRepository,
  ) {}

  /**
   * List the acting tenant's workflow templates, name-ascending, for an org admin. `org.manage`,
   * relation-gated org-scoped (`projectId: null`). The list is tenant-scoped by the repository, so a
   * cross-tenant read is impossible.
   */
  @Get()
  @RequireCapability('org.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('limit') limit?: string,
  ): Promise<{ readonly templates: readonly WorkflowTemplateView[] }> {
    if (!this.mayManageOrg(principal, context)) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'workflow_template_read_denied',
      );
    }

    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (
      parsedLimit !== undefined &&
      (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > MAX_PAGE_SIZE)
    ) {
      throw new ApiError(400, 'validation_failed', 'The request query is invalid', [
        { field: 'limit', message: `must be an integer between 1 and ${MAX_PAGE_SIZE}` },
      ]);
    }

    const rows = await this.database.read(context, (runner) =>
      this.templates.list(runner, context, parsedLimit !== undefined ? { limit: parsedLimit } : {}),
    );
    return { templates: rows.map(toView) };
  }

  /**
   * Define a workflow template. `org.manage`, relation-gated org-scoped: a denial is a 403 — there is
   * no object to hide on a create. The trigger/action allowlist and config bounds are checked before
   * any write, so an off-list or over-size body is a 400 with nothing written.
   */
  @Post()
  @RequireCapability('org.manage')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateTemplateBody,
  ): Promise<WorkflowTemplateView> {
    if (!this.mayManageOrg(principal, context)) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'workflow_template_write_denied',
      );
    }

    const name = validateName(body?.name);
    const triggerKind = validateTriggerKind(body?.triggerKind);
    const actionKind = validateActionKind(body?.actionKind);
    const config = validateConfig(body?.config);
    const enabled = validateEnabled(body?.enabled);

    const row = await this.database.transaction(context, (tx) =>
      this.templates.create(tx, context, {
        name,
        triggerKind,
        actionKind,
        config,
        enabled,
        createdBy: context.userId,
      }),
    );
    return toView(row);
  }

  /**
   * A14 — "Delete rule". Soft-deletes one template (0226): it leaves the list, its id answers 404,
   * and it is turned off so nothing fires it again; its run history stays. `org.manage`. Resolve by
   * `(organization_id, id)` first (404, nothing leaked across tenants), then authorize (403), then
   * delete. A run in flight holds the row, so the delete is refused with a 409 rather than racing it.
   */
  @Delete(':id')
  @RequireCapability('org.manage')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
  ): Promise<void> {
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
    if (!this.mayManageOrg(principal, context)) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'workflow_template_delete_denied',
      );
    }

    let deleted: boolean;
    try {
      deleted = await this.database.transaction(context, (tx) =>
        this.templates.softDelete(tx, context, id),
      );
    } catch (error) {
      if (isRowLockedError(error)) {
        throw new ApiError(
          409,
          'conflict',
          'This rule is running right now. Try again in a moment.',
          undefined,
          'workflow_template_run_in_flight',
        );
      }
      throw error;
    }
    if (!deleted) {
      throw new ApiError(
        404,
        'not_found',
        MESSAGES.notFound,
        undefined,
        'workflow_template_not_found',
      );
    }
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
  return raw as WorkflowTemplateConfig;
}

function validateEnabled(raw: unknown): boolean {
  if (raw === undefined) return true;
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
