import { Body, Controller, HttpCode, Inject, Optional, Param, Post } from '@nestjs/common';
import { AUTOMATION_FLOW_FIELDS, AUTOMATION_FLOW_LIMITS, authorize } from '@tmanage/domain';
import type { ConditionEvent, Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import {
  TENANT_DATABASE,
  WORKFLOW_RUNS_REPOSITORY,
  WORKFLOW_RUN_SERVICE,
  WORKFLOW_TEMPLATES_REPOSITORY,
} from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkflowRunDetail, WorkflowRunRow } from '../../common/database/schema.js';
import type { WorkflowTemplatesRepository } from './templates.repository.js';
import type { WorkflowRunsRepository } from './run.repository.js';
import type { WorkflowRunService } from './run.service.js';
import { NotificationsRepository } from '../inbox/notifications.repository.js';
import { WorkflowFlowVersionsRepository } from './flow-versions.repository.js';

/** CQ-12 (AUT-02): the inbox type of a manual run's test notice. */
export const AUTOMATION_TEST_RUN_TYPE = 'automation.test_run.v1';

/**
 * Automations & integrations (module 17, x163). One endpoint: run a workflow template and record the
 * run. This is the execution half of the module — x162 defines templates at rest; this runs one and
 * writes a `workflow_runs` row for it (audit rank #2, "Automations Missing — execution").
 *
 * ## The capability
 *
 * Running an automation is an org-admin concern, so the route reuses `org.manage` — no `automation.*`
 * capability exists and this slice adds none. `CapabilityGuard` asks the coarse ceiling question; this
 * controller adds the authoritative org-scoped `authorize()` a suspended membership fails.
 *
 * ## The Known-trap order — resolve BEFORE authorize
 *
 * The template id is a path parameter, so it must be **resolved within the acting tenant before any
 * authorization or write**. `findById` is tenant-scoped, so a template id belonging to another studio
 * (or one that does not exist) resolves to `null` and the request is a 404 with nothing written — the
 * existence of another tenant's template is never revealed as a 403. Only once a template in *this*
 * tenant is in hand does the org-scoped `org.manage` decision run (403 on denial), then the
 * enabled-state check (409 on a disabled template), then execution and the single run insert. The
 * tenant is read from the context, never from the request, so a run is written into the acting tenant
 * and nowhere else.
 *
 * ## Execution is in-app only
 *
 * The outcome is decided by {@link WorkflowRunService}, which runs only in-app action kinds and
 * has no network egress (`notify_owner` here writes the runner a test notice in the same transaction
 * as the run — CQ-12); an external kind (`send_email_digest`) records a `failed` run rather than
 * attempting delivery. External delivery is x166 / Needs-Peter.
 */

/** What a caller is allowed to see of one workflow run. `organizationId` is deliberately absent. */
export interface WorkflowRunView {
  readonly id: string;
  readonly templateId: string;
  readonly status: string;
  readonly detail: WorkflowRunDetail;
  /** An ISO-8601 instant. */
  readonly startedAt: string;
  /** An ISO-8601 instant. */
  readonly finishedAt: string;
}

/**
 * 58-C1 — the optional sample a manual test run of a branching rule is decided against (a manual run
 * has no triggering object). Only the fields an If may read, each a bounded string; anything else is
 * a 400 with no run.
 */
function sampleEvent(body: unknown): ConditionEvent | null {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) return null;
  const sample = (body as { readonly event?: unknown }).event;
  if (sample === undefined) return {};
  if (typeof sample !== 'object' || sample === null || Array.isArray(sample)) return null;
  const event: Record<string, string> = {};
  for (const [key, value] of Object.entries(sample)) {
    if (!(AUTOMATION_FLOW_FIELDS as readonly string[]).includes(key)) return null;
    if (typeof value !== 'string' || value.length > AUTOMATION_FLOW_LIMITS.maxValueLength) {
      return null;
    }
    event[key] = value;
  }
  return event;
}

/** An explicit projection, not a serialised row: a column added later is invisible until named. */
function toView(row: WorkflowRunRow): WorkflowRunView {
  return {
    id: row.id,
    templateId: row.templateId,
    status: row.status,
    detail: row.detailJson,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt.toISOString(),
  };
}

@Controller('v1/organizations/:orgSlug/automations/templates/:templateId/run')
export class WorkflowRunController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(WORKFLOW_TEMPLATES_REPOSITORY) private readonly templates: WorkflowTemplatesRepository,
    @Inject(WORKFLOW_RUNS_REPOSITORY) private readonly runs: WorkflowRunsRepository,
    @Inject(WORKFLOW_RUN_SERVICE) private readonly runService: WorkflowRunService,
    @Optional()
    @Inject(NotificationsRepository)
    private readonly notifications: NotificationsRepository = new NotificationsRepository(),
    @Optional()
    @Inject(WorkflowFlowVersionsRepository)
    private readonly flows: WorkflowFlowVersionsRepository = new WorkflowFlowVersionsRepository(),
  ) {}

  /**
   * Run a template. `org.manage`, resolve-before-authorize: a cross-tenant or unknown template id is a
   * 404 with no write; a caller without `org.manage` is a 403; a disabled template is a 409 with no
   * run. On success one `workflow_runs` row is written and returned.
   */
  @Post()
  @RequireCapability('org.manage')
  @HttpCode(201)
  async run(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('templateId') templateId: string,
    @Body() body?: unknown,
  ): Promise<WorkflowRunView> {
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
        'workflow_run_template_not_found',
      );
    }

    if (!this.mayManageOrg(principal, context)) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'workflow_run_denied');
    }

    if (!template.enabled) {
      throw new ApiError(
        409,
        'conflict',
        'The template is disabled and cannot be run',
        undefined,
        'workflow_run_template_disabled',
      );
    }

    const event = sampleEvent(body);
    if (event === null) {
      throw new ApiError(
        400,
        'validation_failed',
        'The sample event may only name status, project_id or object_type, as short text',
        undefined,
        'workflow_run_sample_invalid',
      );
    }

    // 58-C1: a rule with a saved builder graph runs its flow; a linear rule runs as before.
    const saved = await this.database.read(context, (runner) =>
      this.flows.latest(runner, context, template.id),
    );
    const outcome =
      saved === null
        ? this.runService.execute(template.id, template.actionKind, template.triggerKind)
        : this.runService.executeFlow(
            template.id,
            template.triggerKind,
            saved.version,
            saved.flow,
            event,
          );

    const row = await this.database.transaction(context, async (tx) => {
      const recorded = await this.runs.record(tx, context, {
        templateId: template.id,
        status: outcome.status,
        detail: outcome.detail,
      });
      // CQ-12 (AUT-02): the effect the run reports is real. A manual run has no triggering
      // object, so its notice goes to the person who ran it, about the rule itself.
      if (outcome.notifiesRunner) {
        await this.notifications.insertForRecipient(tx, context, {
          recipientUserId: context.userId,
          type: AUTOMATION_TEST_RUN_TYPE,
          objectType: 'workflow_template',
          objectId: template.id,
          dedupeKey: `automation.test_run:${recorded.id}`,
        });
      }
      return recorded;
    });
    return toView(row);
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
