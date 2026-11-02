import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import {
  AUDIT_SERVICE,
  PERSON_ALLOCATIONS_REPOSITORY,
  PROJECTS_REPOSITORY,
  MEMBERSHIPS_REPOSITORY,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { PersonAllocationRow } from '../../common/database/schema.js';
import { PERSON_ALLOCATION_STATUSES } from './allocations.repository.js';
import type {
  PersonAllocationStatus,
  PersonAllocationsRepository,
  UpdatePersonAllocationPatch,
} from './allocations.repository.js';
import type { AuditService } from '../audit/audit.service.js';
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
  /** 53-08: `tentative` allocations are shown apart from planned hours until confirmed. */
  readonly status: PersonAllocationStatus;
  /** 53-08: explicit weekly hours; null → `percent` of the member's capacity. */
  readonly hoursPerWeek: number | null;
  readonly note: string | null;
}

interface CreateAllocationBody {
  readonly membershipId?: unknown;
  readonly percent?: unknown;
  readonly startDate?: unknown;
  readonly endDate?: unknown;
  readonly status?: unknown;
  readonly hoursPerWeek?: unknown;
  readonly note?: unknown;
}

/** 53-08 (R21-b): the PATCH body. `status` is read only to refuse it (confirm is the one path). */
interface UpdateAllocationBody {
  readonly percent?: unknown;
  readonly startDate?: unknown;
  readonly endDate?: unknown;
  readonly hoursPerWeek?: unknown;
  readonly note?: unknown;
  readonly status?: unknown;
}

/** 53-08 bounds: a week has 168 hours; a note is one short line. */
const MAX_HOURS_PER_WEEK = 168;
const MAX_NOTE_LENGTH = 300;

/** 53-08 (R21-b): the removed row's values the delete audit keeps as `before`. */
const DELETED_AUDIT_FIELDS = [
  'percent',
  'status',
  'startDate',
  'endDate',
  'hoursPerWeek',
  'note',
] as const;

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
    status: row.status === 'tentative' ? 'tentative' : 'confirmed',
    hoursPerWeek: row.hoursPerWeek === null ? null : Number(row.hoursPerWeek),
    note: row.note,
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
    @Inject(AUDIT_SERVICE) private readonly audit: Pick<AuditService, 'record'>,
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
    const status = parseStatus(body?.status);
    const hoursPerWeek = parseHoursPerWeek(body?.hoursPerWeek);
    const note = parseNote(body?.note);

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
        status,
        hoursPerWeek,
        note,
      }),
    );
    return toView(row);
  }

  /**
   * 53-08: confirm a tentative allocation — it then counts toward planned hours. `project.manage`
   * on the named project (relation-checked like create); an unknown, cross-tenant or other-project
   * allocation id is a 404; an allocation already confirmed is a 409 with no write. Audited
   * (`person_allocation.confirmed`, status before/after) in the same transaction as the UPDATE.
   */
  @Post(':id/confirm')
  @RequireCapability('project.manage')
  @HttpCode(200)
  async confirm(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Param('id') allocationId: string,
  ): Promise<PersonAllocationView> {
    if (principal.kind === 'client') {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'allocation_confirm_denied',
      );
    }
    await this.requireVisibleProject(context, principal, projectId, 'project.manage');

    const notFound = (): ApiError =>
      new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'allocation_not_visible');
    const alreadyConfirmed = (): ApiError =>
      new ApiError(
        409,
        'conflict',
        'This allocation is already confirmed',
        [{ field: 'status', message: 'already confirmed' }],
        'allocation_already_confirmed',
      );

    const existing = await this.database.read(context, (runner) =>
      this.allocations.findById(runner, context, allocationId),
    );
    if (!existing || existing.projectId !== projectId) throw notFound();
    if (existing.status !== 'tentative') throw alreadyConfirmed();

    const row = await this.database.transaction(context, async (tx) => {
      const outcome = await this.allocations.confirm(tx, context, allocationId);
      if (outcome === 'not_found') throw notFound();
      if (outcome === 'already_confirmed') throw alreadyConfirmed();
      await this.audit.record(tx, context, {
        action: 'person_allocation.confirmed',
        result: 'allowed',
        objectId: allocationId,
        actorUserId: context.userId,
        metadata: { project_id: projectId },
        changes: [{ field: 'status', before: 'tentative', after: 'confirmed' }],
      });
      return this.allocations.requireById(tx, context, allocationId);
    });
    return toView(row);
  }

  /**
   * 53-08 (R21-b): edit an allocation's percent, dates, weekly hours or note. `project.manage` on
   * the named project (relation-checked like create); a client principal is a 403. `status` is not
   * accepted (409 `use_confirm`: confirm stays the one path tentative -> confirmed, and confirmed
   * never goes back); an empty body is a 400; a start after the end (stored values merged with the
   * patch) is a 400 `invalid_range`. An unknown, cross-tenant or other-project id is a 404 with no
   * write and no audit row. Audited (`person_allocation.updated`, the changed fields before/after)
   * in the UPDATE's transaction.
   */
  @Patch(':id')
  @RequireCapability('project.manage')
  async update(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Param('id') allocationId: string,
    @Body() body: UpdateAllocationBody,
  ): Promise<PersonAllocationView> {
    if (principal.kind === 'client') {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'allocation_edit_denied');
    }
    await this.requireVisibleProject(context, principal, projectId, 'project.manage');

    if (body?.status !== undefined) {
      throw new ApiError(
        409,
        'conflict',
        'Status changes go through confirm',
        [{ field: 'status', message: 'use POST /allocations/:id/confirm' }],
        'use_confirm',
      );
    }
    const patch = parsePatch(body);
    if (Object.keys(patch).length === 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        {
          field: 'body',
          message: 'name at least one of percent, startDate, endDate, hoursPerWeek, note',
        },
      ]);
    }

    const notFound = (): ApiError =>
      new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'allocation_not_visible');

    const row = await this.database.transaction(context, async (tx) => {
      const existing = await this.allocations.findById(tx, context, allocationId);
      if (!existing || existing.projectId !== projectId) throw notFound();
      const before = toView(existing);
      const start = patch.startDate === undefined ? before.startDate : patch.startDate;
      const end = patch.endDate === undefined ? before.endDate : patch.endDate;
      if (start !== null && end !== null && start > end) {
        throw new ApiError(
          400,
          'validation_failed',
          'The request body is invalid',
          [{ field: 'endDate', message: 'must not be before startDate' }],
          'invalid_range',
        );
      }
      const updated = await this.allocations.update(tx, context, projectId, allocationId, patch);
      if (!updated) throw notFound();
      const after = toView(updated);
      const changes = (Object.keys(patch) as (keyof UpdatePersonAllocationPatch)[])
        .filter((field) => before[field] !== after[field])
        .map((field) => ({ field, before: before[field], after: after[field] }));
      await this.audit.record(tx, context, {
        action: 'person_allocation.updated',
        result: 'allowed',
        objectId: allocationId,
        actorUserId: context.userId,
        metadata: { project_id: projectId },
        changes,
      });
      return updated;
    });
    return toView(row);
  }

  /**
   * 53-08 (R21-b): remove an allocation. A hard delete: `person_allocations` (0069) has no
   * `deleted_at` -- an allocation is a planning fact, not a record, and the audit row
   * (`person_allocation.deleted`, the row's values as `before`) keeps what it was. `project.manage`
   * relation-checked; a client principal is a 403; an unknown, cross-tenant or other-project id is a
   * 404 with no audit row. 204 on success.
   */
  @Delete(':id')
  @RequireCapability('project.manage')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Param('id') allocationId: string,
  ): Promise<void> {
    if (principal.kind === 'client') {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'allocation_delete_denied',
      );
    }
    await this.requireVisibleProject(context, principal, projectId, 'project.manage');

    const notFound = (): ApiError =>
      new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'allocation_not_visible');

    await this.database.transaction(context, async (tx) => {
      const existing = await this.allocations.findById(tx, context, allocationId);
      if (!existing || existing.projectId !== projectId) throw notFound();
      const removed = await this.allocations.remove(tx, context, projectId, allocationId);
      if (removed === 0) throw notFound();
      const before = toView(existing);
      await this.audit.record(tx, context, {
        action: 'person_allocation.deleted',
        result: 'allowed',
        objectId: allocationId,
        actorUserId: context.userId,
        metadata: { project_id: projectId, membership_id: existing.membershipId },
        changes: DELETED_AUDIT_FIELDS.map((field) => ({
          field,
          before: before[field],
          after: null,
        })),
      });
    });
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

/** 53-08: optional `status`, default `'confirmed'`; anything else is a 400. */
function parseStatus(value: unknown): PersonAllocationStatus {
  if (value === undefined || value === null) return 'confirmed';
  if (
    typeof value === 'string' &&
    (PERSON_ALLOCATION_STATUSES as readonly string[]).includes(value)
  ) {
    return value as PersonAllocationStatus;
  }
  throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
    { field: 'status', message: "must be 'tentative' or 'confirmed'" },
  ]);
}

/** 53-08: optional `hoursPerWeek`, 0 < n ≤ 168 with at most two decimals; else a 400. */
function parseHoursPerWeek(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > MAX_HOURS_PER_WEEK ||
    Math.abs(Math.round(value * 100) - value * 100) > 1e-6
  ) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      {
        field: 'hoursPerWeek',
        message: `must be a number above 0 and at most ${MAX_HOURS_PER_WEEK}, with two decimals`,
      },
    ]);
  }
  return value;
}

/** 53-08: optional `note`, at most 300 characters; blank → null. */
function parseNote(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > MAX_NOTE_LENGTH) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'note', message: `must be text of at most ${MAX_NOTE_LENGTH} characters` },
    ]);
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * 53-08 (R21-b): the PATCH body -> a patch. Absent fields stay absent; each present field is checked
 * with the same bounds as create. `startDate` / `endDate` / `hoursPerWeek` / `note` accept `null`
 * to clear; `percent` does not.
 */
function parsePatch(body: UpdateAllocationBody | undefined): UpdatePersonAllocationPatch {
  const invalid = (field: string, message: string): ApiError =>
    new ApiError(400, 'validation_failed', 'The request body is invalid', [{ field, message }]);
  const out: {
    percent?: number;
    startDate?: string | null;
    endDate?: string | null;
    hoursPerWeek?: number | null;
    note?: string | null;
  } = {};
  if (body?.percent !== undefined) {
    const percent = body.percent;
    if (
      typeof percent !== 'number' ||
      !Number.isInteger(percent) ||
      percent < MIN_PERCENT ||
      percent > MAX_PERCENT
    ) {
      throw invalid('percent', `must be an integer between ${MIN_PERCENT} and ${MAX_PERCENT}`);
    }
    out.percent = percent;
  }
  for (const field of ['startDate', 'endDate'] as const) {
    const value = body?.[field];
    if (value === undefined) continue;
    if (value === null) {
      out[field] = null;
      continue;
    }
    if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
      throw invalid(field, 'must be a date in YYYY-MM-DD form, or null');
    }
    out[field] = value;
  }
  if (body?.hoursPerWeek !== undefined) out.hoursPerWeek = parseHoursPerWeek(body.hoursPerWeek);
  if (body?.note !== undefined) out.note = parseNote(body.note);
  return out;
}
