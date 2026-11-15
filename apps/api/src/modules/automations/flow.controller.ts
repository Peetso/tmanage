import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Optional,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { authorize, flowIssues, linearAutomationFlow, parseAutomationFlow } from '@tmanage/domain';
import type { AutomationFlow, AutomationFlowIssue, Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { TENANT_DATABASE, WORKFLOW_TEMPLATES_REPOSITORY } from '../../common/http/tokens.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { WorkflowTemplateRow } from '../../common/database/schema.js';
import type { WorkflowTemplatesRepository } from './templates.repository.js';
import { WorkflowFlowVersionsRepository } from './flow-versions.repository.js';

/**
 * 58-C1 — the branching rule builder's API: read the graph in force, save a new version of it, and
 * turn the rule on once the graph is complete.
 *
 * Same order as every automation route: the template is resolved by the composite tenant key first
 * (unknown or cross-tenant id → 404, nothing authorized or written), then the org-scoped
 * `org.manage` decision (403), then the body. A save checks the graph's shape server-side
 * (`parseAutomationFlow`: known action kinds, fields and operators, bounded size and depth, no
 * cycle, no orphan) and refuses an unfinished graph on a rule that is on — an on rule can only
 * hold a graph that runs. A rule's capabilities never come from its graph: the graph only names
 * action kinds from the fixed allowlist.
 */

const EMPTY_FLOW: AutomationFlow = { start: null, nodes: [] };

/** What the builder reads. `version` is `null` for a linear rule that was never opened in it. */
export interface WorkflowFlowView {
  readonly templateId: string;
  readonly version: number | null;
  readonly flow: AutomationFlow;
  readonly issues: readonly AutomationFlowIssue[];
  readonly enabled: boolean;
}

@Controller('v1/organizations/:orgSlug/automations/templates/:templateId/flow')
export class WorkflowFlowController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(WORKFLOW_TEMPLATES_REPOSITORY) private readonly templates: WorkflowTemplatesRepository,
    @Optional()
    @Inject(WorkflowFlowVersionsRepository)
    private readonly flows: WorkflowFlowVersionsRepository = new WorkflowFlowVersionsRepository(),
  ) {}

  /** The graph in force; a linear rule reads as its one-step, branch-less graph. */
  @Get()
  @RequireCapability('org.manage')
  async read(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('templateId') templateId: string,
  ): Promise<WorkflowFlowView> {
    const template = await this.resolve(context, principal, templateId);
    return this.database.read(context, (runner) => this.view(runner, context, template));
  }

  /** Save the builder's graph as the next version. 400 on a bad shape, 409 on an unfinished on rule. */
  @Put()
  @RequireCapability('org.manage')
  async save(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('templateId') templateId: string,
    @Body() body: unknown,
  ): Promise<WorkflowFlowView> {
    const template = await this.resolve(context, principal, templateId);
    const raw =
      typeof body === 'object' && body !== null ? (body as { readonly flow?: unknown }).flow : null;
    const parsed = parseAutomationFlow(raw);
    if (!parsed.ok) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: parsed.nodeId === null ? 'flow' : `flow.${parsed.nodeId}`, message: parsed.error },
      ]);
    }
    if (template.enabled && flowIssues(parsed.flow).length > 0) {
      throw new ApiError(
        409,
        'conflict',
        'Finish every step before saving a rule that is on',
        undefined,
        'workflow_flow_incomplete',
      );
    }
    return this.database.transaction(context, async (tx) => {
      await this.flows.append(tx, context, template.id, parsed.flow);
      return this.view(tx, context, template);
    });
  }

  /** Turn the rule on — only when the graph in force has no unfinished step or empty branch. */
  @Post('turn-on')
  @RequireCapability('org.manage')
  @HttpCode(200)
  async turnOn(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('templateId') templateId: string,
  ): Promise<WorkflowFlowView> {
    const template = await this.resolve(context, principal, templateId);
    return this.database.transaction(context, async (tx) => {
      const current = await this.view(tx, context, template);
      if (current.issues.length > 0) {
        throw new ApiError(
          409,
          'conflict',
          'Finish every step before turning this rule on',
          undefined,
          'workflow_flow_incomplete',
        );
      }
      const updated = await this.templates.update(tx, context, template.id, { enabled: true });
      if (!updated) throw this.notFound();
      return { ...current, enabled: updated.enabled };
    });
  }

  private async view(
    runner: TenantQueryRunner,
    context: TenantContext,
    template: WorkflowTemplateRow,
  ): Promise<WorkflowFlowView> {
    const saved = await this.flows.latest(runner, context, template.id);
    const flow =
      saved === null ? linearAutomationFlow(template.actionKind) : (saved.flow ?? EMPTY_FLOW);
    return {
      templateId: template.id,
      version: saved?.version ?? null,
      flow,
      issues: flowIssues(flow),
      enabled: template.enabled,
    };
  }

  /** Resolve within the tenant BEFORE authorize: a cross-tenant or unknown id is a 404, not a 403. */
  private async resolve(
    context: TenantContext,
    principal: Principal,
    templateId: string,
  ): Promise<WorkflowTemplateRow> {
    const template = await this.database.read(context, (runner) =>
      this.templates.findById(runner, context, templateId),
    );
    if (!template) throw this.notFound();
    const allowed = authorize({
      principal,
      capability: 'org.manage',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
    if (!allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'workflow_flow_denied');
    }
    return template;
  }

  private notFound(): ApiError {
    return new ApiError(
      404,
      'not_found',
      MESSAGES.notFound,
      undefined,
      'workflow_flow_template_not_found',
    );
  }
}
