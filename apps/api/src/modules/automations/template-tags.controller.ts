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
import {
  AUTOMATION_TEMPLATE_TAGS_SERVICE,
  TENANT_DATABASE,
  WORKFLOW_TEMPLATES_REPOSITORY,
} from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type {
  AutomationTemplateTagRow,
  WorkflowTemplateRow,
} from '../../common/database/schema.js';
import type { WorkflowTemplatesRepository } from './templates.repository.js';
import type { AutomationTemplateTagsService } from './template-tags.service.js';

/**
 * Automations & integrations (module 17, x335). Free-text tags on a workflow template: list a
 * template's tags, add one, remove one, and filter the org's templates by a tag. Completes the tagging
 * pattern for the automations module.
 *
 * ## The capability
 *
 * Automations are an org-configured concern, so every route reuses `org.manage` — no `automation.*`
 * capability exists and this slice adds none. `CapabilityGuard` asks the coarse ceiling question; this
 * controller adds the authoritative org-scoped `authorize()` (`projectId: null`) a suspended
 * membership fails, exactly as the sibling automation controllers do.
 *
 * ## The Known-trap order — resolve BEFORE authorize
 *
 * A template id on a tag route is a path parameter, so it is **resolved within the acting tenant before
 * any authorization or write**. `findById` is tenant-scoped, so a template id belonging to another
 * studio (or one that does not exist) resolves to `null` and the request is a 404 — the existence of
 * another tenant's template is never revealed as a 403. Only once a template in *this* tenant is in
 * hand does the `org.manage` decision run (403), then the label validation, then the single write. The
 * tenant is read from the context, never from the request, so a tag is written into the acting tenant
 * and nowhere else. The tag filter is org-scoped by the repository join, so it can only ever return
 * this tenant's templates.
 */

/** What a caller is allowed to see of one tag. `organizationId` is deliberately absent. */
export interface AutomationTemplateTagView {
  readonly id: string;
  readonly templateId: string;
  readonly label: string;
  readonly createdBy: string;
  /** An ISO-8601 instant. */
  readonly createdAt: string;
}

/**
 * One template in the tag-filter result — the minimal reference a filtered list needs.
 * `organizationId` is deliberately absent; `name` is what the list renders and `id` is what it links to.
 */
export interface AutomationTaggedTemplateView {
  readonly id: string;
  readonly name: string;
}

/** An explicit projection, not a serialised row: a column added later is invisible until named. */
function toTagView(row: AutomationTemplateTagRow): AutomationTemplateTagView {
  return {
    id: row.id,
    templateId: row.workflowTemplateId,
    label: row.label,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

function toTaggedTemplateView(row: WorkflowTemplateRow): AutomationTaggedTemplateView {
  return { id: row.id, name: row.name };
}

interface CreateTagBody {
  readonly label?: unknown;
}

@Controller('v1/organizations/:orgSlug/automations')
export class AutomationTemplateTagsController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(WORKFLOW_TEMPLATES_REPOSITORY) private readonly templates: WorkflowTemplatesRepository,
    @Inject(AUTOMATION_TEMPLATE_TAGS_SERVICE)
    private readonly tags: AutomationTemplateTagsService,
  ) {}

  /**
   * List a template's tags, label order. `org.manage`, resolve-before-authorize: a cross-tenant or
   * unknown template id is a 404; a caller without `org.manage` is a 403.
   */
  @Get('templates/:templateId/tags')
  @RequireCapability('org.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('templateId') templateId: string,
  ): Promise<{ readonly tags: readonly AutomationTemplateTagView[] }> {
    const template = await this.resolveTemplate(context, templateId);
    this.assertMayManageOrg(principal, context);
    const rows = await this.tags.list(context, template.id);
    return { tags: rows.map(toTagView) };
  }

  /**
   * Add a tag to a template. `org.manage`, resolve-before-authorize: a cross-tenant or unknown
   * template id is a 404 with no write; a caller without `org.manage` is a 403; an empty or over-length
   * label is a 400 with nothing written; a label already on the template is a 409. On success one
   * `automation_template_tags` row is written and returned.
   */
  @Post('templates/:templateId/tags')
  @RequireCapability('org.manage')
  @HttpCode(201)
  async add(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('templateId') templateId: string,
    @Body() body: CreateTagBody,
  ): Promise<AutomationTemplateTagView> {
    const template = await this.resolveTemplate(context, templateId);
    this.assertMayManageOrg(principal, context);
    const row = await this.tags.add(context, template.id, body?.label);
    return toTagView(row);
  }

  /**
   * Remove a tag from a template, idempotently (204 whether or not it was present). `org.manage`,
   * resolve-before-authorize: a cross-tenant or unknown template id is a 404 with no delete; a caller
   * without `org.manage` is a 403.
   */
  @Delete('templates/:templateId/tags/:tagId')
  @RequireCapability('org.manage')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('templateId') templateId: string,
    @Param('tagId') tagId: string,
  ): Promise<void> {
    const template = await this.resolveTemplate(context, templateId);
    this.assertMayManageOrg(principal, context);
    await this.tags.remove(context, template.id, tagId);
  }

  /**
   * Filter the org's templates by a tag. `org.manage`, org-scoped (`projectId: null`): a caller without
   * the capability is a 403; an empty `tag` query is a 400. The join is tenant-scoped, so only this
   * tenant's templates are ever returned.
   */
  @Get('template-tags')
  @RequireCapability('org.manage')
  async filter(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('tag') tag?: string,
  ): Promise<{ readonly templates: readonly AutomationTaggedTemplateView[] }> {
    this.assertMayManageOrg(principal, context);
    const rows = await this.tags.templatesByTag(context, tag);
    return { templates: rows.map(toTaggedTemplateView) };
  }

  /** Resolve a template within the acting tenant BEFORE authorize: a cross-tenant/unknown id → 404. */
  private async resolveTemplate(
    context: TenantContext,
    templateId: string,
  ): Promise<WorkflowTemplateRow> {
    const template = await this.database.read(context, (runner) =>
      this.templates.findById(runner, context, templateId),
    );
    if (!template) {
      throw new ApiError(
        404,
        'not_found',
        MESSAGES.notFound,
        undefined,
        'automation_template_tag_template_not_found',
      );
    }
    return template;
  }

  /** Org-scoped deny-by-default decision the route guard cannot make (membership status, etc.). */
  private assertMayManageOrg(principal: Principal, context: TenantContext): void {
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
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'automation_template_tag_denied',
      );
    }
  }
}
