import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { PROJECTS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { ProjectView, ProjectsService } from './projects.service.js';

/**
 * The first tenant-scoped endpoints, and the thing that proves the pipeline runs in order.
 *
 * Note what this controller does **not** do. It does not read `organizationId` from anywhere —
 * not the body, not a header, not even the `:orgSlug` in its own path. It receives a
 * `TenantContext` that `TenantContextGuard` built from a membership row, and passes it on.
 * `25-AUTH-AND-TENANT-ISOLATION` §2 requires exactly that, and the shape of `CreateProjectBody`
 * is what makes it structural: there is no field for a tenant, so there is nothing for a
 * caller to supply and nothing for a handler to prefer over the context.
 *
 * The `:orgSlug` segment is in the path because it is the claim under test — the guard needs
 * something to resolve — and it is never used again after that resolution.
 */

interface CreateProjectBody {
  readonly workspaceId?: unknown;
  readonly name?: unknown;
  readonly ownerUserId?: unknown;
  /**
   * `ON-03`'s date, as a `YYYY-MM-DD` string.
   *
   * Named `targetDate` rather than `dueDate` or `deadline`, and that is not decoration:
   * `22-SCREEN-BY-SCREEN` §3 says the date "is marked target until milestone plan confirmed",
   * and the field a client posts to should say the same thing the screen says. It lands in
   * `projects.forecast_at`, never in `committed_at`.
   */
  readonly targetDate?: unknown;
}

/** `organizations.name`'s width is 190; `projects.name` is the same. */
const MAX_PROJECT_NAME_LENGTH = 190;

@Controller('v1/organizations/:orgSlug/projects')
export class ProjectsController {
  constructor(@Inject(PROJECTS_SERVICE) private readonly projects: ProjectsService) {}

  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
  ): Promise<{ readonly projects: readonly ProjectView[] }> {
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && !Number.isSafeInteger(parsedLimit)) {
      throw new ApiError(400, 'validation_failed', 'limit must be an integer', [
        { field: 'limit', message: 'must be an integer' },
      ]);
    }

    return {
      projects: await this.projects.list(context, principal, {
        ...(after ? { after } : {}),
        ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
      }),
    };
  }

  @Get(':projectId')
  @RequireCapability('work.read')
  async get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<ProjectView> {
    return this.projects.get(context, principal, projectId);
  }

  @Post()
  @RequireCapability('project.create')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @Body() body: CreateProjectBody,
  ): Promise<ProjectView> {
    const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId : undefined;
    const name = typeof body?.name === 'string' ? body.name.trim() : undefined;

    const details = [
      ...(workspaceId ? [] : [{ field: 'workspaceId', message: 'must be a string' }]),
      ...(name ? [] : [{ field: 'name', message: 'must be a non-empty string' }]),
      ...(name && name.length > MAX_PROJECT_NAME_LENGTH
        ? [{ field: 'name', message: `must be ${MAX_PROJECT_NAME_LENGTH} characters or fewer` }]
        : []),
    ];

    const forecastAt = parseTargetDate(body?.targetDate, details);

    const ownerUserId =
      typeof body?.ownerUserId === 'string' && body.ownerUserId !== ''
        ? body.ownerUserId
        : undefined;

    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    // The workspace is not checked against the tenant here, and that is not an omission:
    // `fk_projects_workspace_tenant` is a composite foreign key including `organization_id`,
    // so the database refuses a workspace from another organization. See
    // `ProjectsRepository.create`.
    //
    // The owner is **not** checked either, and that one is a real gap rather than a
    // constraint doing the work: `fk_projects_owner` references `users (id)` without
    // `organization_id`, because a user is not tenant-owned. So a caller who knows another
    // organization's user id could name them as owner of a project here. It is recorded in
    // `docs/implementation-status.md`; closing it needs a membership read, which belongs with
    // `PEOPLE-001`'s people picker rather than bolted on here.
    // Narrowed by the `details.length` check above, which TypeScript cannot see through: the
    // guard is on a separate array rather than on these two bindings. Asserted rather than
    // assumed, so an edit that removes the check fails here instead of inserting a null name.
    if (!workspaceId || !name) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.projects.create(context, {
      workspaceId,
      name,
      ...(ownerUserId === undefined ? {} : { ownerUserId }),
      ...(forecastAt === undefined ? {} : { forecastAt }),
    });
  }
}

/**
 * Parse `YYYY-MM-DD` into a `Date`, or add a field error.
 *
 * Midnight **UTC**, deliberately. A date with no time is a calendar date, and interpreting it
 * in the server's local zone would make the same string mean different instants on two
 * machines — and shift by a day for anyone west of Greenwich. The organization's own timezone
 * is what a deadline should eventually be rendered through; storing the calendar date at a
 * fixed instant keeps that a display decision rather than a storage one.
 *
 * `undefined` for an absent date and for a rejected one alike; the caller reads `details` to
 * tell them apart, which it does by checking `details.length` before using the result.
 */
function parseTargetDate(
  raw: unknown,
  details: { field: string; message: string }[],
): Date | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;

  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    details.push({ field: 'targetDate', message: 'must be a date in YYYY-MM-DD form' });
    return undefined;
  }

  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    details.push({ field: 'targetDate', message: 'is not a real date' });
    return undefined;
  }

  // `2026-02-31` parses in some engines by rolling into March. Round-tripping catches it.
  if (parsed.toISOString().slice(0, 10) !== raw) {
    details.push({ field: 'targetDate', message: 'is not a real date' });
    return undefined;
  }

  return parsed;
}
