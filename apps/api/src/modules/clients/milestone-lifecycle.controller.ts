import { Body, Controller, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { MILESTONE_LIFECYCLE_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { ProjectMilestonesRepository } from './project-milestones.repository.js';
import type { UpdateProjectMilestonePatch } from './project-milestones.repository.js';
import { toProjectMilestoneView } from './project-milestones.projection.js';
import type { ProjectMilestoneView } from './project-milestones.controller.js';

/**
 * SEC / Portal milestone lifecycle (x202) — edit and complete an existing milestone.
 *
 * The x139 slice created and read milestones but left them frozen: the audit records "Portal
 * milestones published-only in pass 20; no edit/complete". This slice adds the two write
 * transitions a manager needs — correcting a milestone's title or target date, and marking it
 * reached — on the **internal** `projects` path behind `project.manage`, the capability no client
 * role holds. It touches no new table (reusing `project_milestones` 0048) and no capability.
 *
 * The client projection is deliberately untouched: `PortalMilestonesController` still reads only
 * published milestones through `ClientMilestoneView`, which carries neither staff identity nor the
 * publish flag. This file adds no client-facing route, so nothing here can widen what a client sees.
 */

/**
 * A milestone after an edit or completion — the **internal** edit view (`project.manage`).
 *
 * It is {@link ProjectMilestoneView} plus `updatedAt`: the write transitions record *when* they
 * happened, and for `complete` that instant is the milestone's completion date. There is no
 * dedicated `completed_at` column (this slice adds no migration), so the completion date is
 * `updated_at` — the moment `status` moved to `met` — surfaced here rather than invented in a new
 * column. Like the sibling internal view it carries `createdByUserId`; it never leaves the internal
 * `projects` path, so a client never receives it.
 */
export interface MilestoneEditView {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  /** A 'YYYY-MM-DD' target day, or null when the date is not committed. */
  readonly dueOn: string | null;
  readonly status: ProjectMilestoneView['status'];
  readonly published: boolean;
  readonly createdByUserId: string;
  /** An ISO-8601 instant on the wire. */
  readonly createdAt: string;
  /** An ISO-8601 instant — the last edit, and for a completed milestone its completion date. */
  readonly updatedAt: string;
}

/** `project_milestones.title` is VARCHAR(300). */
const MAX_MILESTONE_TITLE_LENGTH = 300;

/** A calendar day, `YYYY-MM-DD` — the shape a MySQL `DATE` column round-trips as a string. */
const DUE_ON_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The milestone state a `complete` transition sets.
 *
 * The status enum is `planned | met | missed` (0048); there is no `complete` value. A milestone is
 * *complete* when it has been **met** — the achieved terminal state — so `complete` sets `met`.
 */
const COMPLETED_STATUS = 'met' as const;

/** What an internal principal edits. The tenant and the ids come from the route/context, not the body. */
export interface EditMilestoneCommand {
  readonly projectId: string;
  readonly milestoneId: string;
  readonly patch: UpdateProjectMilestonePatch;
}

/**
 * The milestone lifecycle service — resolve tenant-scoped, authorize, then edit or complete.
 *
 * Defined here beside its controller (its only caller) and exercised directly by the unit suite
 * with the real `authorize()` over fakes for the database and repositories, exactly as the x139
 * `ProjectMilestonesService` is.
 */
export class MilestoneLifecycleService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
    private readonly milestones: ProjectMilestonesRepository = new ProjectMilestonesRepository(),
  ) {}

  /**
   * Edit a milestone's mutable fields — `project.manage`, internal only.
   *
   * The Known-trap order: the route names the project **and** the milestone by id, so both are
   * resolved tenant-scoped before any write. The project is resolved and the caller's manage
   * relation checked first ({@link resolveManageable}) — an unknown/cross-tenant project or a
   * caller who cannot manage it is 404, never 403. Then the milestone is fetched tenant-scoped and
   * confirmed to belong to *that* project; a milestone id from another project (or another tenant,
   * or absent) is 404 with no write. Identity is never in the patch, so a client body cannot
   * re-point a milestone even if it reached here.
   */
  async edit(
    context: TenantContext,
    principal: Principal,
    input: EditMilestoneCommand,
  ): Promise<MilestoneEditView> {
    await this.resolveManageable(context, principal, input.projectId);
    await this.resolveMilestone(context, input.projectId, input.milestoneId);

    const row = await this.database.transaction(context, (tx) =>
      this.milestones.update(tx, context, input.milestoneId, input.patch),
    );
    if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound);

    return toMilestoneEditView(row);
  }

  /**
   * Complete a milestone — set `status = met` (+ completion date via `updated_at`). `project.manage`.
   *
   * Same resolve-then-write order as {@link edit}: the project and the milestone are both resolved
   * tenant-scoped and the manage relation checked before the status write, so a cross-tenant or
   * unknown id is 404 and nothing is written.
   */
  async complete(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    milestoneId: string,
  ): Promise<MilestoneEditView> {
    await this.resolveManageable(context, principal, projectId);
    await this.resolveMilestone(context, projectId, milestoneId);

    const row = await this.database.transaction(context, (tx) =>
      this.milestones.update(tx, context, milestoneId, { status: COMPLETED_STATUS }),
    );
    if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound);

    return toMilestoneEditView(row);
  }

  /**
   * Resolve the project tenant-scoped, then check the caller may manage it. 404 on either miss, so
   * a caller learns neither which projects exist nor which they are barred from.
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

  /**
   * Fetch the milestone tenant-scoped and confirm it belongs to the named project. 404 when the
   * milestone does not exist in this tenant, or exists but under a different project — a milestone
   * id must not be editable through a project path it does not belong to.
   */
  private async resolveMilestone(
    context: TenantContext,
    projectId: string,
    milestoneId: string,
  ): Promise<void> {
    const milestone = await this.database.read(context, (runner) =>
      this.milestones.findById(runner, context, milestoneId),
    );
    if (!milestone || milestone.projectId !== projectId) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'milestone_not_visible');
    }
  }
}

/** Build the edit view for the patch — validates the mutable fields, rejecting identity/publish. */
function parseEditBody(
  projectId: string,
  milestoneId: string,
  body: unknown,
): EditMilestoneCommand {
  const record = (body ?? {}) as Record<string, unknown>;
  const details: { field: string; message: string }[] = [];
  const patch: { title?: string; dueOn?: string | null } = {};

  if ('title' in record) {
    const rawTitle = record['title'];
    const title = typeof rawTitle === 'string' ? rawTitle.trim() : undefined;
    if (!title) {
      details.push({ field: 'title', message: 'must be a non-empty string' });
    } else if (title.length > MAX_MILESTONE_TITLE_LENGTH) {
      details.push({
        field: 'title',
        message: `must be ${MAX_MILESTONE_TITLE_LENGTH} characters or fewer`,
      });
    } else {
      patch.title = title;
    }
  }

  if ('dueOn' in record) {
    const rawDueOn = record['dueOn'];
    if (rawDueOn === null) {
      patch.dueOn = null;
    } else if (typeof rawDueOn === 'string' && DUE_ON_PATTERN.test(rawDueOn)) {
      patch.dueOn = rawDueOn;
    } else {
      details.push({ field: 'dueOn', message: 'must be a YYYY-MM-DD date or null' });
    }
  }

  if (details.length > 0) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
  }
  if (patch.title === undefined && patch.dueOn === undefined) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'title', message: 'provide at least one of title or dueOn to edit' },
    ]);
  }

  return { projectId, milestoneId, patch };
}

/** The internal edit view — the full record plus `updatedAt`. Built field by field. */
function toMilestoneEditView(row: Parameters<typeof toProjectMilestoneView>[0]): MilestoneEditView {
  return { ...toProjectMilestoneView(row), updatedAt: row.updatedAt.toISOString() };
}

/**
 * The milestone lifecycle surface — `project.manage`, on the internal `projects` path. A client
 * principal never holds `project.manage`, so `CapabilityGuard` refuses them with 403 before the
 * handler runs; the service applies the object-level decision (404 for a project/milestone they
 * cannot reach).
 */
@Controller('v1/organizations/:orgSlug/projects')
export class MilestoneLifecycleController {
  constructor(
    @Inject(MILESTONE_LIFECYCLE_SERVICE) private readonly lifecycle: MilestoneLifecycleService,
  ) {}

  @Patch(':projectId/milestones/:id')
  @RequireCapability('project.manage')
  async edit(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Param('id') milestoneId: string,
    @Body() body: unknown,
  ): Promise<MilestoneEditView> {
    return this.lifecycle.edit(context, principal, parseEditBody(projectId, milestoneId, body));
  }

  @Post(':projectId/milestones/:id/complete')
  @RequireCapability('project.manage')
  @HttpCode(200)
  async complete(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Param('id') milestoneId: string,
  ): Promise<MilestoneEditView> {
    return this.lifecycle.complete(context, principal, projectId, milestoneId);
  }
}
