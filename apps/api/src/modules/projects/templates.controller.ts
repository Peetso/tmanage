import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { PROJECT_TEMPLATES_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { ProjectTemplateView, ProjectTemplatesService } from './templates.service.js';
import type { ProjectView } from './projects.service.js';

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
}

interface InstantiateBody {
  readonly workspaceId?: unknown;
  readonly name?: unknown;
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
    });
  }
}
