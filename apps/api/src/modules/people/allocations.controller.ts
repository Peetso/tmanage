import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import {
  PERSON_ALLOCATIONS_REPOSITORY,
  PROJECTS_REPOSITORY,
  MEMBERSHIPS_REPOSITORY,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { PersonAllocationRow } from '../../common/database/schema.js';
import type { PersonAllocationsRepository } from './allocations.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { MembershipsRepository } from '../tenancy/memberships.repository.js';

/**
 * PEOPLE / module 14 (x171). A project's people allocations: assign a member a share of their time to
 * a project, and list the project's allocations. (Audit #4: People Missing — allocation view.)
 *
 * Nested under `…/projects/:projectId/allocations`, so the project is named in the path. Writes are
 * gated on `project.manage`, the list on `work.read` — the coarse ceiling `CapabilityGuard` checks
 * before the handler runs (a role without it is a 403). This controller adds the two things the guard
 * cannot: it resolves **both** ids the request names — the project AND the membership — tenant-scoped
 * before it authorizes or writes (Known-trap: an unknown or cross-tenant id is a 404, never a
 * foreign-key 500), then the **relation** check (`authorize()` with the row's project in hand), so a
 * member without organization-wide scope acts only on their own projects and a non-member's probe
 * earns the same not-found rather than a 403 that would confirm the project exists.
 *
 * Like every tenant-scoped controller here it never reads `organizationId` from the body, a header, or
 * its own `:orgSlug` segment: it receives the `TenantContext` that `TenantContextGuard` built from a
 * membership row and passes it on.
 */

/** What a caller is allowed to see of an allocation. `organizationId` is deliberately absent. */
export interface PersonAllocationView {
  readonly id: string;
  readonly projectId: string;
  readonly membershipId: string;
  readonly percent: number;
  readonly startDate: string | null;
  readonly endDate: string | null;
  /** An ISO-8601 instant. */
  readonly createdAt: string;
}

interface CreateAllocationBody {
  readonly membershipId?: unknown;
  readonly percent?: unknown;
  readonly startDate?: unknown;
  readonly endDate?: unknown;
}

const MIN_PERCENT = 1;
const MAX_PERCENT = 100;
/** Calendar dates travel as `'YYYY-MM-DD'` strings (07-DATA-MODEL §Dates). */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * An explicit projection, not a serialised row (`25-AUTH-AND-TENANT-ISOLATION` §7). Listing the
 * fields means a column added to `person_allocations` in a future migration is invisible to every
 * caller until someone decides otherwise. `organization_id` is never echoed into a response body.
 */
function toView(row: PersonAllocationRow): PersonAllocationView {
  return {
    id: row.id,
    projectId: row.projectId,
    membershipId: row.membershipId,
    percent: row.percent,
    startDate: row.startDate,
    endDate: row.endDate,
    createdAt: row.createdAt.toISOString(),
  };
}

@Controller('v1/organizations/:orgSlug/projects/:projectId/allocations')
export class PersonAllocationsController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(PERSON_ALLOCATIONS_REPOSITORY)
    private readonly allocations: PersonAllocationsRepository,
    @Inject(PROJECTS_REPOSITORY) private readonly projects: ProjectsRepository,
    @Inject(MEMBERSHIPS_REPOSITORY) private readonly memberships: MembershipsRepository,
  ) {}

  /**
   * Resolve a project the principal may act on under `capability`, tenant- and relation-scoped, or
   * throw the not-found that both an unknown id and a non-member's probe must earn.
   */
  private async requireVisibleProject(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    capability: 'project.manage' | 'work.read',
  ): Promise<void> {
    const project = await this.database.read(context, (runner) =>
      this.projects.findById(runner, context, projectId),
    );
    if (!project) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
    }
    const permitted = authorize({
      principal,
      capability,
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

  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Query('limit') limit?: string,
  ): Promise<{ readonly allocations: readonly PersonAllocationView[] }> {
    if (typeof projectId !== 'string' || projectId === '') {
      throw new ApiError(400, 'validation_failed', 'projectId is required', [
        { field: 'projectId', message: 'must be a non-empty string' },
      ]);
    }

    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && !Number.isSafeInteger(parsedLimit)) {
      throw new ApiError(400, 'validation_failed', 'limit must be an integer', [
        { field: 'limit', message: 'must be an integer' },
      ]);
    }

    // Resolve the project read-visible first (Known-trap): unknown/cross-tenant, and a non-member's
    // probe, both earn the same not-found before any read.
    await this.requireVisibleProject(context, principal, projectId, 'work.read');

    const rows = await this.database.read(context, (runner) =>
      this.allocations.list(runner, context, {
        projectId,
        ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
      }),
    );
    return { allocations: rows.map(toView) };
  }

  @Post()
  @RequireCapability('project.manage')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Body() body: CreateAllocationBody,
  ): Promise<PersonAllocationView> {
    if (typeof projectId !== 'string' || projectId === '') {
      throw new ApiError(400, 'validation_failed', 'projectId is required', [
        { field: 'projectId', message: 'must be a non-empty string' },
      ]);
    }

    const membershipId =
      typeof body?.membershipId === 'string' && body.membershipId.trim() !== ''
        ? body.membershipId.trim()
        : undefined;
    if (!membershipId) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'membershipId', message: 'must be a non-empty string' },
      ]);
    }

    // Known-trap: resolve BOTH ids tenant-scoped BEFORE authorize and before any write. An unknown or
    // cross-tenant project or membership is a 404 with no write, never a foreign-key 500.
    await this.requireVisibleProject(context, principal, projectId, 'project.manage');

    const membership = await this.database.read(context, (runner) =>
      this.memberships.findById(runner, context, membershipId),
    );
    if (!membership) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'membership_not_visible');
    }

    // Value validation, after the ids are proven visible.
    const percent = body?.percent;
    if (
      typeof percent !== 'number' ||
      !Number.isInteger(percent) ||
      percent < MIN_PERCENT ||
      percent > MAX_PERCENT
    ) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        {
          field: 'percent',
          message: `must be an integer between ${MIN_PERCENT} and ${MAX_PERCENT}`,
        },
      ]);
    }

    const startDate = this.optionalDate(body?.startDate, 'startDate');
    const endDate = this.optionalDate(body?.endDate, 'endDate');

    // One active allocation per (project, membership): a duplicate is a 409 with no second row.
    const active = await this.database.read(context, (runner) =>
      this.allocations.findActiveForMember(runner, context, projectId, membershipId),
    );
    if (active) {
      throw new ApiError(
        409,
        'conflict',
        'This member already has an active allocation on this project',
        [{ field: 'membershipId', message: 'an active allocation already exists' }],
        'duplicate_active_allocation',
      );
    }

    const row = await this.database.transaction(context, (tx) =>
      this.allocations.create(tx, context, {
        projectId,
        membershipId,
        percent,
        ...(startDate === undefined ? {} : { startDate }),
        ...(endDate === undefined ? {} : { endDate }),
      }),
    );
    return toView(row);
  }

  /** Validate an optional `'YYYY-MM-DD'` date field: absent → undefined, present-and-malformed → 400. */
  private optionalDate(value: unknown, field: string): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field, message: 'must be a date in YYYY-MM-DD form' },
      ]);
    }
    return value;
  }
}
