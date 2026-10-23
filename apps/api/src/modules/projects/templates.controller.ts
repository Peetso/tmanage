import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { PROJECT_TEMPLATES_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { ProjectTemplateView, ProjectTemplatesService } from './templates.service.js';
import type { ProjectView } from './projects.service.js';
import type {
  ProjectTemplateMilestone,
  ProjectTemplateWorkItem,
} from '../../common/database/schema.js';

/**
 * PROJ / module 8 (x234). Reusable project templates: define, list, and instantiate.
 *
 * Org-scoped (a template has no project in its path), so every route is gated on `project.manage` and
 * the service authorizes against an org-level resource. Like every tenant-scoped controller here, it
 * never reads `organizationId` from the body, a header, or its own `:orgSlug` segment.
 *
 * `POST :id/instantiate` creates a project **through the shared project-create path** — the response is
 * an ordinary `ProjectView`, indistinguishable from a project created directly.
 */

interface CreateTemplateBody {
  readonly name?: unknown;
  readonly description?: unknown;
  readonly defaultObjectives?: unknown;
  readonly milestones?: unknown;
  readonly workItems?: unknown;
  readonly clientPortalOn?: unknown;
  readonly repeatInterval?: unknown;
}

interface InstantiateBody {
  readonly workspaceId?: unknown;
  readonly name?: unknown;
  readonly startDate?: unknown;
  readonly clientOrganizationId?: unknown;
  readonly leadUserId?: unknown;
}

/** A9: a calendar day, `YYYY-MM-DD`. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** A9: a template copies a bounded plan. */
const MAX_TEMPLATE_MILESTONES = 100;
const MAX_TEMPLATE_WORK_ITEMS = 200;
/** A9: offsets stay within ten years of the start date. */
const MAX_OFFSET_DAYS = 3650;
/** `project_milestones.title` / `work_items.title` are VARCHAR(300). */
const MAX_PLAN_TITLE_LENGTH = 300;

type Details = { field: string; message: string }[];

function isOffset(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_OFFSET_DAYS
  );
}

function planTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed !== '' && trimmed.length <= MAX_PLAN_TITLE_LENGTH ? trimmed : undefined;
}

/** A9 — `milestones`: `[{ title, offsetDays, description?, clientVisible? }]`, bounded. */
function parseTemplateMilestones(
  raw: unknown,
  details: Details,
): readonly ProjectTemplateMilestone[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length > MAX_TEMPLATE_MILESTONES) {
    details.push({
      field: 'milestones',
      message: `must be an array of ${MAX_TEMPLATE_MILESTONES} milestones or fewer`,
    });
    return undefined;
  }
  const cleaned: ProjectTemplateMilestone[] = [];
  for (const entry of raw as unknown[]) {
    const record = (entry ?? {}) as Record<string, unknown>;
    const title = planTitle(record['title']);
    const description = record['description'];
    const clientVisible = record['clientVisible'];
    if (
      !title ||
      !isOffset(record['offsetDays']) ||
      (description !== undefined && typeof description !== 'string') ||
      (clientVisible !== undefined && typeof clientVisible !== 'boolean')
    ) {
      details.push({
        field: 'milestones',
        message: 'each milestone needs a title and a whole-day offsetDays',
      });
      return undefined;
    }
    cleaned.push({
      title,
      offsetDays: record['offsetDays'] as number,
      ...(typeof description === 'string' && description.trim() !== ''
        ? { description: description.trim() }
        : {}),
      ...(typeof clientVisible === 'boolean' ? { clientVisible } : {}),
    });
  }
  return cleaned;
}

/** A9 — `workItems`: `[{ title, offsetDays? }]`, bounded. */
function parseTemplateWorkItems(
  raw: unknown,
  details: Details,
): readonly ProjectTemplateWorkItem[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length > MAX_TEMPLATE_WORK_ITEMS) {
    details.push({
      field: 'workItems',
      message: `must be an array of ${MAX_TEMPLATE_WORK_ITEMS} work items or fewer`,
    });
    return undefined;
  }
  const cleaned: ProjectTemplateWorkItem[] = [];
  for (const entry of raw as unknown[]) {
    const record = (entry ?? {}) as Record<string, unknown>;
    const title = planTitle(record['title']);
    const offsetDays = record['offsetDays'];
    if (!title || (offsetDays !== undefined && !isOffset(offsetDays))) {
      details.push({ field: 'workItems', message: 'each work item needs a title' });
      return undefined;
    }
    cleaned.push({ title, ...(offsetDays === undefined ? {} : { offsetDays }) });
  }
  return cleaned;
}

/** An optional id field: absent or blank ⇒ undefined; otherwise a string of at most 36 chars. */
function optionalId(raw: unknown, field: string, details: Details): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string' || raw.length > 36) {
    details.push({ field, message: 'must be an id' });
    return undefined;
  }
  return raw;
}

/** `project_templates.name` is `VARCHAR(190)`, matching `projects.name`. */
const MAX_NAME_LENGTH = 190;
/** `description` is `TEXT`; this is a form field, not a document. */
const MAX_DESCRIPTION_LENGTH = 20_000;
/** A template declares a bounded set of default objectives. */
const MAX_DEFAULT_OBJECTIVES = 50;
/** `project_objectives.title` is `VARCHAR(300)`; a default-objective title is the same kind of label. */
const MAX_OBJECTIVE_TITLE_LENGTH = 300;

/**
 * Validate `defaultObjectives`: absent ⇒ undefined; otherwise an array of non-empty strings, bounded in
 * count and length. A malformed value pushes a field error and returns undefined (the caller reads
 * `details.length` to tell an absent value from a rejected one).
 */
function parseDefaultObjectives(
  raw: unknown,
  details: { field: string; message: string }[],
): readonly string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    details.push({ field: 'defaultObjectives', message: 'must be an array of strings' });
    return undefined;
  }
  if (raw.length > MAX_DEFAULT_OBJECTIVES) {
    details.push({
      field: 'defaultObjectives',
      message: `must have ${MAX_DEFAULT_OBJECTIVES} entries or fewer`,
    });
    return undefined;
  }
  const cleaned: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      details.push({
        field: 'defaultObjectives',
        message: 'each entry must be a non-empty string',
      });
      return undefined;
    }
    const trimmed = entry.trim();
    if (trimmed.length > MAX_OBJECTIVE_TITLE_LENGTH) {
      details.push({
        field: 'defaultObjectives',
        message: `each entry must be ${MAX_OBJECTIVE_TITLE_LENGTH} characters or fewer`,
      });
      return undefined;
    }
    cleaned.push(trimmed);
  }
  return cleaned;
}

@Controller('v1/organizations/:orgSlug/projects/templates')
export class ProjectTemplatesController {
  constructor(
    @Inject(PROJECT_TEMPLATES_SERVICE) private readonly templates: ProjectTemplatesService,
  ) {}

  @Get()
  @RequireCapability('project.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('limit') limit?: string,
  ): Promise<{ readonly templates: readonly ProjectTemplateView[] }> {
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && !Number.isSafeInteger(parsedLimit)) {
      throw new ApiError(400, 'validation_failed', 'limit must be an integer', [
        { field: 'limit', message: 'must be an integer' },
      ]);
    }

    return {
      templates: await this.templates.list(context, principal, {
        ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
      }),
    };
  }

  @Post()
  @RequireCapability('project.manage')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateTemplateBody,
  ): Promise<ProjectTemplateView> {
    const name = typeof body?.name === 'string' ? body.name.trim() : undefined;
    const description =
      typeof body?.description === 'string' && body.description.trim() !== ''
        ? body.description.trim()
        : undefined;

    const details = [
      ...(name ? [] : [{ field: 'name', message: 'must be a non-empty string' }]),
      ...(name && name.length > MAX_NAME_LENGTH
        ? [{ field: 'name', message: `must be ${MAX_NAME_LENGTH} characters or fewer` }]
        : []),
      ...(body?.description !== undefined && typeof body?.description !== 'string'
        ? [{ field: 'description', message: 'must be a string' }]
        : []),
      ...(description && description.length > MAX_DESCRIPTION_LENGTH
        ? [
            {
              field: 'description',
              message: `must be ${MAX_DESCRIPTION_LENGTH} characters or fewer`,
            },
          ]
        : []),
    ];

    const defaultObjectives = parseDefaultObjectives(body?.defaultObjectives, details);
    const milestones = parseTemplateMilestones(body?.milestones, details);
    const workItems = parseTemplateWorkItems(body?.workItems, details);
    const clientPortalOn = body?.clientPortalOn;
    if (clientPortalOn !== undefined && typeof clientPortalOn !== 'boolean') {
      details.push({ field: 'clientPortalOn', message: 'must be a boolean' });
    }
    const repeatInterval = body?.repeatInterval;
    if (repeatInterval !== undefined && repeatInterval !== null && repeatInterval !== 'monthly') {
      details.push({ field: 'repeatInterval', message: "must be 'monthly' or null" });
    }

    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }
    // Narrowed by the `details.length` check above, which TypeScript cannot see through.
    if (!name) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.templates.create(context, principal, {
      name,
      ...(description === undefined ? {} : { description }),
      ...(defaultObjectives === undefined ? {} : { defaultObjectives }),
      ...(milestones === undefined ? {} : { milestones }),
      ...(workItems === undefined ? {} : { workItems }),
      ...(typeof clientPortalOn === 'boolean' ? { clientPortalOn } : {}),
      ...(repeatInterval === 'monthly' ? { repeatInterval } : {}),
    });
  }

  /**
   * Create a project from a template. The template is named by id in the path (the service resolves it
   * tenant-scoped before it authorizes). The body carries the `workspaceId` the new project lives in
   * and an optional `name` override; without one the project takes the template's name.
   */
  @Post(':templateId/instantiate')
  @RequireCapability('project.manage')
  @HttpCode(201)
  async instantiate(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('templateId') templateId: string,
    @Body() body: InstantiateBody,
  ): Promise<ProjectView> {
    if (typeof templateId !== 'string' || templateId === '') {
      throw new ApiError(400, 'validation_failed', 'templateId is required', [
        { field: 'templateId', message: 'must be a non-empty string' },
      ]);
    }

    const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId : undefined;
    const name =
      typeof body?.name === 'string' && body.name.trim() !== '' ? body.name.trim() : undefined;

    const details = [
      ...(workspaceId ? [] : [{ field: 'workspaceId', message: 'must be a string' }]),
      ...(name && name.length > MAX_NAME_LENGTH
        ? [{ field: 'name', message: `must be ${MAX_NAME_LENGTH} characters or fewer` }]
        : []),
    ];
    const rawStart = body?.startDate;
    const startDate =
      typeof rawStart === 'string' && DAY_PATTERN.test(rawStart) ? rawStart : undefined;
    if (rawStart !== undefined && rawStart !== null && startDate === undefined) {
      details.push({ field: 'startDate', message: 'must be a YYYY-MM-DD date' });
    }
    const clientOrganizationId = optionalId(
      body?.clientOrganizationId,
      'clientOrganizationId',
      details,
    );
    const leadUserId = optionalId(body?.leadUserId, 'leadUserId', details);

    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }
    // Narrowed by the `details.length` check above, which TypeScript cannot see through.
    if (!workspaceId) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.templates.instantiate(context, principal, templateId, {
      workspaceId,
      ...(name === undefined ? {} : { name }),
      ...(startDate === undefined ? {} : { startDate }),
      ...(clientOrganizationId === undefined ? {} : { clientOrganizationId }),
      ...(leadUserId === undefined ? {} : { leadUserId }),
    });
  }
}
