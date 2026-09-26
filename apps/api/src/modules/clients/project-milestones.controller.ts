import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { PROJECT_MILESTONES_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import {
  ProjectMilestonesRepository,
  effectivePageSize as milestonePageSize,
} from './project-milestones.repository.js';
import type { ProjectMilestoneStatus } from './project-milestones.repository.js';
import {
  isProjectMilestoneStatus,
  toClientMilestoneView,
  toProjectMilestoneView,
} from './project-milestones.projection.js';
import type {
  ClientMilestoneView,
  ProjectMilestoneView,
} from './project-milestones.projection.js';

/**
 * SEC / Portal milestones (x139) — the internal write/read surface and the client projection.
 *
 * The design mirrors CLIENT-003 (project_updates, x125) exactly, and for the same reasons:
 *
 * - The **internal** routes (`POST`/`GET projects/:projectId/milestones`) live on the internal
 *   `projects` path behind `project.manage`, which no client role holds. Keeping the write and the
 *   full read off `/portal` means a client principal never reaches them — a security property, not
 *   a routing preference.
 * - The **client** route (`GET portal/projects/:projectId/milestones`) is on a path of its own and
 *   serves the client projection ({@link ClientMilestoneView}), which never carries staff identity
 *   or the publish flag, from a query that only ever selects `published = 1`.
 *
 * The two controllers share one {@link ProjectMilestonesService}: the project is resolved
 * tenant-scoped and relation-checked there, and the milestone store reads or appends against it.
 */

/** `project_milestones.title` is VARCHAR(300). */
const MAX_MILESTONE_TITLE_LENGTH = 300;

/** A calendar day, `YYYY-MM-DD` — the shape a MySQL `DATE` column round-trips as a string. */
const DUE_ON_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** What an internal principal creates. The tenant and the author come from the context, never the body. */
export interface CreateMilestoneCommand {
  readonly projectId: string;
  readonly title: string;
  readonly dueOn: string | null;
  readonly status: ProjectMilestoneStatus;
  readonly published: boolean;
}

/**
 * The milestones service — resolve the project tenant-scoped, authorize, then read or write.
 *
 * It is defined here beside the controllers rather than in a file of its own because the two
 * controllers are its only callers and the whole slice is one cohesive unit; the unit suite
 * (`project-milestones.controller.test.ts`) exercises it directly with the real `authorize()` over
 * fakes for the database and the repositories.
 */
export class ProjectMilestonesService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
    private readonly milestones: ProjectMilestonesRepository = new ProjectMilestonesRepository(),
  ) {}

  /**
   * Create a milestone — the internal half. `project.manage`, internal only.
   *
   * The Known-trap order (FAST-PROTOCOL 19:55): the route names the project by id, so the project
   * is resolved **tenant-scoped first** ({@link ProjectsRepository.findById}). An unknown or
   * cross-tenant `projectId` returns `null` → 404, **before** any authorize or write — without it
   * an org-wide caller would drive the id into the composite foreign key, a 500 rather than a
   * not-found. Then the relation check with the project in hand: a caller who cannot manage the
   * project gets 404, never 403 (403 would confirm it exists). The author is `context.userId`,
   * never a body field.
   */
  async create(
    context: TenantContext,
    principal: Principal,
    input: CreateMilestoneCommand,
  ): Promise<ProjectMilestoneView> {
    await this.resolveManageable(context, principal, input.projectId);

    const row = await this.database.transaction(context, (tx) =>
      this.milestones.create(tx, context, {
        projectId: input.projectId,
        title: input.title,
        dueOn: input.dueOn,
        status: input.status,
        published: input.published,
        createdByUserId: context.userId,
      }),
    );

    return toProjectMilestoneView(row);
  }

  /** The full internal list for one project — `project.manage`, internal only. */
  async listInternal(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<readonly ProjectMilestoneView[]> {
    await this.resolveManageable(context, principal, projectId);

    const limit = milestonePageSize(undefined);
    const rows = await this.database.read(context, (runner) =>
      this.milestones.list(runner, context, { projectId, publishedOnly: false, limit }),
    );
    return rows.map(toProjectMilestoneView);
  }

  /**
   * The published milestones for one project this client may read — the client half.
   *
   * {@link mayRead} runs `authorize()` rule 10 for a client — the project must be in
   * `principal.projectIds`, which comes from `project_clients` and nothing else — and an unknown,
   * cross-tenant or sibling-client `projectId` fails it. The refusal is **404, not 403**: a client
   * probing project ids must not learn which of them are real.
   *
   * `published = 1` is a **query predicate**, not a `.filter()` afterwards, so an unpublished
   * milestone is never in the result set; and {@link toClientMilestoneView} carries no staff
   * identity, so even the published rows leak nothing internal.
   */
  async listForClient(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<readonly ClientMilestoneView[]> {
    if (!this.mayRead(principal, projectId)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }

    const limit = milestonePageSize(undefined);
    const rows = await this.database.read(context, (runner) =>
      this.milestones.list(runner, context, { projectId, publishedOnly: true, limit }),
    );
    return rows.map(toClientMilestoneView);
  }

  /**
   * Resolve the project tenant-scoped, then check the caller may manage it. Throws 404 on either
   * miss, so a caller can tell neither which projects exist nor which they are barred from.
   */
  private async resolveManageable(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<void> {
    const project = await this.database.read(context, (runner) =>
      this.projects.findById(runner, context, projectId),
    );
    if (!project) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
    }

    const permitted = authorize({
      principal,
      capability: 'project.manage',
      resource: {
        organizationId: context.organizationId,
        projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;

    if (!permitted) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
    }
  }

  /** May this principal read the client projection of this project? `authorize()` rules 7-10. */
  private mayRead(principal: Principal, projectId: string): boolean {
    return authorize({
      principal,
      capability: 'client_projection.read',
      resource: {
        organizationId: principal.organizationId,
        projectId,
        audience: 'client_visible',
        clientOrganizationId: principal.clientOrganizationId,
        lifecycle: 'active',
      },
    }).allowed;
  }
}

/** Shared body parsing for the create route. Throws `validation_failed` with field details. */
function parseCreateBody(projectId: string, body: unknown): CreateMilestoneCommand {
  const record = (body ?? {}) as Record<string, unknown>;
  const details: { field: string; message: string }[] = [];

  const title = typeof record.title === 'string' ? record.title.trim() : undefined;
  if (!title) {
    details.push({ field: 'title', message: 'must be a non-empty string' });
  } else if (title.length > MAX_MILESTONE_TITLE_LENGTH) {
    details.push({
      field: 'title',
      message: `must be ${MAX_MILESTONE_TITLE_LENGTH} characters or fewer`,
    });
  }

  let dueOn: string | null = null;
  if (record.dueOn !== undefined && record.dueOn !== null) {
    if (typeof record.dueOn === 'string' && DUE_ON_PATTERN.test(record.dueOn)) {
      dueOn = record.dueOn;
    } else {
      details.push({ field: 'dueOn', message: 'must be a YYYY-MM-DD date or null' });
    }
  }

  // Defaults to 'planned' — a milestone is set before it is met or missed.
  let status: ProjectMilestoneStatus = 'planned';
  if (record.status !== undefined) {
    if (isProjectMilestoneStatus(record.status)) {
      status = record.status;
    } else {
      details.push({ field: 'status', message: 'must be one of planned, met, missed' });
    }
  }

  if (record.published !== undefined && typeof record.published !== 'boolean') {
    details.push({ field: 'published', message: 'must be a boolean' });
  }
  // Defaults to true — a milestone created on the portal surface is meant to be seen; a draft is
  // the explicit opt-out (`published: false`). The publish/unpublish lifecycle is a later slice.
  const published = record.published === undefined ? true : (record.published as boolean);

  if (details.length > 0 || !title) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
  }

  return { projectId, title, dueOn, status, published };
}

/**
 * The internal milestones surface — `project.manage`, on the `projects` path. A client principal
 * never holds `project.manage`, so `CapabilityGuard` refuses them here with 403 before the handler
 * runs; the service applies the object-level decision (404 for a project they cannot manage).
 */
@Controller('v1/organizations/:orgSlug/projects')
export class ProjectMilestonesController {
  constructor(
    @Inject(PROJECT_MILESTONES_SERVICE) private readonly milestones: ProjectMilestonesService,
  ) {}

  @Post(':projectId/milestones')
  @RequireCapability('project.manage')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ): Promise<ProjectMilestoneView> {
    return this.milestones.create(context, principal, parseCreateBody(projectId, body));
  }

  @Get(':projectId/milestones')
  @RequireCapability('project.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<{ readonly milestones: readonly ProjectMilestoneView[] }> {
    return { milestones: await this.milestones.listInternal(context, principal, projectId) };
  }
}

/**
 * The client milestones projection — `client_projection.read`, on the `/portal` path. Published
 * only, no staff identity, 404 (not 403, not an empty list) for a project this client cannot read.
 */
@Controller('v1/organizations/:orgSlug/portal')
export class PortalMilestonesController {
  constructor(
    @Inject(PROJECT_MILESTONES_SERVICE) private readonly milestones: ProjectMilestonesService,
  ) {}

  @Get('projects/:projectId/milestones')
  @RequireCapability('client_projection.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<{ readonly milestones: readonly ClientMilestoneView[] }> {
    return { milestones: await this.milestones.listForClient(context, principal, projectId) };
  }
}
