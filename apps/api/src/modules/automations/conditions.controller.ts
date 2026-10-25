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
} from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import {
  AUDIT_SERVICE,
  TENANT_DATABASE,
  WORKFLOW_CONDITIONS_REPOSITORY,
  WORKFLOW_TEMPLATES_REPOSITORY,
} from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import {
  WORKFLOW_CONDITION_OPS,
  type WorkflowConditionOp,
  type WorkflowConditionRow,
} from '../../common/database/schema.js';
import type { WorkflowTemplatesRepository } from './templates.repository.js';
import type { WorkflowConditionsRepository } from './conditions.repository.js';
import type { AuditService } from '../audit/audit.service.js';

/**
 * Automations & integrations (module 17, x190). Three endpoints under one template: list a template's
 * conditions, add one, and (C1) remove one. A **condition** is a `(field, op, value)` predicate bound to a `target_step`;
 * the run evaluator (x163) reads a template's conditions to decide whether a step fires. Before this
 * slice, steps ran unconditionally — there was no condition model.
 *
 * ## The capability
 *
 * Conditions are part of authoring an automation, an org-admin concern, so both routes reuse
 * `org.manage` — no `automation.*` capability exists and this slice adds none. `CapabilityGuard` asks
 * the coarse ceiling question; this controller adds the authoritative org-scoped `authorize()` a
 * suspended membership fails.
 *
 * ## The Known-trap order — resolve BEFORE authorize
 *
 * The template id is a path parameter, so it is **resolved within the acting tenant before any
 * authorization or write**. `findById` is tenant-scoped, so a template id belonging to another studio
 * (or one that does not exist) resolves to `null` and the request is a 404 with nothing written — the
 * existence of another tenant's template is never revealed as a 403. Only once a template in *this*
 * tenant is in hand does the org-scoped `org.manage` decision run (403 on denial), then the body
 * validation, then the single insert. The tenant is read from the context, never from the request, so a
 * condition is written into the acting tenant and nowhere else.
 *
 * The `op` is checked against a fixed application allowlist ({@link WORKFLOW_CONDITION_OPS}) before any
 * write — an off-list operator is a 400 with nothing written.
 */

/** The comparison operators exposed on the wire. Mirrors the schema allowlist. */
export const CONDITION_OPS = WORKFLOW_CONDITION_OPS;

/** `workflow_conditions.field` is `VARCHAR(200)`. */
const MAX_FIELD_LENGTH = 200;
/** `workflow_conditions.value` is `VARCHAR(500)`. */
const MAX_VALUE_LENGTH = 500;
/** A step index is small and non-negative; a template does not have thousands of steps. */
const MAX_TARGET_STEP = 1000;

/** What a caller is allowed to see of one workflow condition. `organizationId` is deliberately absent. */
export interface WorkflowConditionView {
  readonly id: string;
  readonly templateId: string;
  readonly field: string;
  readonly op: string;
  readonly value: string;
  readonly targetStep: number;
  readonly createdBy: string;
  /** An ISO-8601 instant. */
  readonly createdAt: string;
}

/** An explicit projection, not a serialised row: a column added later is invisible until named. */
function toView(row: WorkflowConditionRow): WorkflowConditionView {
  return {
    id: row.id,
    templateId: row.templateId,
    field: row.field,
    op: row.op,
    value: row.value,
    targetStep: row.targetStep,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

interface CreateConditionBody {
  readonly field?: unknown;
  readonly op?: unknown;
  readonly value?: unknown;
  readonly targetStep?: unknown;
}

@Controller('v1/organizations/:orgSlug/automations/templates/:templateId/conditions')
export class WorkflowConditionsController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(WORKFLOW_TEMPLATES_REPOSITORY) private readonly templates: WorkflowTemplatesRepository,
    @Inject(WORKFLOW_CONDITIONS_REPOSITORY)
    private readonly conditions: WorkflowConditionsRepository,
    @Optional() @Inject(AUDIT_SERVICE) private readonly audit?: AuditService,
  ) {}

  /**
   * List a template's conditions, in step order. `org.manage`, resolve-before-authorize: a cross-tenant
   * or unknown template id is a 404; a caller without `org.manage` is a 403.
   */
  @Get()
  @RequireCapability('org.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('templateId') templateId: string,
  ): Promise<{ readonly conditions: readonly WorkflowConditionView[] }> {
    // Resolve BEFORE authorize: tenant-scoped, so a cross-tenant/unknown id is a 404, not a 403.
    const template = await this.database.read(context, (runner) =>
      this.templates.findById(runner, context, templateId),
    );
    if (!template) {
      throw new ApiError(
        404,
        'not_found',
        MESSAGES.notFound,
        undefined,
        'workflow_condition_template_not_found',
      );
    }

    if (!this.mayManageOrg(principal, context)) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'workflow_condition_read_denied',
      );
    }

    const rows = await this.database.read(context, (runner) =>
      this.conditions.listForTemplate(runner, context, template.id),
    );
    return { conditions: rows.map(toView) };
  }

  /**
   * Add a condition to a template. `org.manage`, resolve-before-authorize: a cross-tenant or unknown
   * template id is a 404 with no write; a caller without `org.manage` is a 403; an off-list `op` or an
   * invalid `field`/`value`/`targetStep` is a 400 with nothing written. On success one
   * `workflow_conditions` row is written and returned.
   */
  @Post()
  @RequireCapability('org.manage')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('templateId') templateId: string,
    @Body() body: CreateConditionBody,
  ): Promise<WorkflowConditionView> {
    // Resolve BEFORE authorize: tenant-scoped, so a cross-tenant/unknown id is a 404, not a 403.
    const template = await this.database.read(context, (runner) =>
      this.templates.findById(runner, context, templateId),
    );
    if (!template) {
      throw new ApiError(
        404,
        'not_found',
        MESSAGES.notFound,
        undefined,
        'workflow_condition_template_not_found',
      );
    }

    if (!this.mayManageOrg(principal, context)) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'workflow_condition_write_denied',
      );
    }

    const field = validateField(body?.field);
    const op = validateOp(body?.op);
    const value = validateValue(body?.value);
    const targetStep = validateTargetStep(body?.targetStep);

    const row = await this.database.transaction(context, (tx) =>
      this.conditions.create(tx, context, {
        templateId: template.id,
        field,
        op,
        value,
        targetStep,
        createdBy: context.userId,
      }),
    );
    return toView(row);
  }

  /**
   * C1 — remove one condition from a rule (204). Same permission as editing the rule (`org.manage`)
   * and the same order: resolve the template within the tenant first (404, nothing leaked across
   * studios), then authorize (403), then resolve the condition *on that template* (404 for an id
   * from another template or tenant), then delete it and record `workflow_condition.deleted` in the
   * same transaction — the condition is gone only if its audit row is written too.
   */
  @Delete(':conditionId')
  @RequireCapability('org.manage')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('templateId') templateId: string,
    @Param('conditionId') conditionId: string,
  ): Promise<void> {
    const template = await this.database.read(context, (runner) =>
      this.templates.findById(runner, context, templateId),
    );
    if (!template) {
      throw new ApiError(
        404,
        'not_found',
        MESSAGES.notFound,
        undefined,
        'workflow_condition_template_not_found',
      );
    }

    if (!this.mayManageOrg(principal, context)) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'workflow_condition_delete_denied',
      );
    }

    const removed = await this.database.transaction(context, async (tx) => {
      const condition = await this.conditions.findById(tx, context, conditionId);
      if (!condition || condition.templateId !== template.id) return null;
      const deleted = await this.conditions.deleteForTemplate(
        tx,
        context,
        template.id,
        condition.id,
      );
      if (!deleted) return null;
      await this.audit?.record(tx, context, {
        action: 'workflow_condition.deleted',
        objectId: condition.id,
        result: 'allowed',
        metadata: { template_id: template.id, op: condition.op, target_step: condition.targetStep },
      });
      return condition;
    });
    if (!removed) {
      throw new ApiError(
        404,
        'not_found',
        MESSAGES.notFound,
        undefined,
        'workflow_condition_not_found',
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

function validateField(raw: unknown): string {
  const field = typeof raw === 'string' ? raw.trim() : '';
  if (field === '') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'field', message: 'must be a non-empty string' },
    ]);
  }
  if (field.length > MAX_FIELD_LENGTH) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'field', message: `must be ${MAX_FIELD_LENGTH} characters or fewer` },
    ]);
  }
  return field;
}

function validateOp(raw: unknown): WorkflowConditionOp {
  if (!isConditionOp(raw)) {
    throw new ApiError(
      400,
      'validation_failed',
      'The request body is invalid',
      [{ field: 'op', message: `must be one of ${WORKFLOW_CONDITION_OPS.join(', ')}` }],
      'workflow_condition_op_off_list',
    );
  }
  return raw;
}

function validateValue(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'value', message: 'must be a string' },
    ]);
  }
  if (raw.length > MAX_VALUE_LENGTH) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'value', message: `must be ${MAX_VALUE_LENGTH} characters or fewer` },
    ]);
  }
  return raw;
}

function validateTargetStep(raw: unknown): number {
  if (!Number.isSafeInteger(raw) || (raw as number) < 0 || (raw as number) > MAX_TARGET_STEP) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'targetStep', message: `must be an integer between 0 and ${MAX_TARGET_STEP}` },
    ]);
  }
  return raw as number;
}

function isConditionOp(value: unknown): value is WorkflowConditionOp {
  return typeof value === 'string' && (WORKFLOW_CONDITION_OPS as readonly string[]).includes(value);
}
