import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Patch,
  Query,
} from '@nestjs/common';
import { WORK_ITEM_STATES } from '@tmanage/domain';
import type { Audience, Principal, WorkItemState } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import {
  parsePlanningFields,
  type WorkItemPlanningChange,
} from '../iterations/work-item-planning.js';
import { WORK_ITEMS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import {
  AuthScheme,
  dependencySourceOf,
  parseTypedDependency,
} from './schedule-cascade.controller.js';
import type {
  ProjectHealthView,
  WorkBlockerView,
  WorkItemDependencyView,
  WorkItemHealthView,
  WorkItemView,
  WorkItemsService,
} from './work-items.service.js';

/**
 * WORK-001's HTTP surface.
 *
 * The same shape as `ProjectsController` and the same rule about what it does not do: it reads
 * no `organizationId` from anywhere, because `TenantContextGuard` built the `TenantContext`
 * from a membership row and there is no field on any body below for a caller to supply one.
 *
 * Three things are specific to this aggregate and worth reading before the code:
 *
 * 1. **State is not a field.** There is no `state` on the create or update body. A work item
 *    starts at the lifecycle's initial state and moves through `POST :id/transitions`, so the
 *    only way to change it is through the machine that decides whether the change is legal.
 *    A `PATCH` that accepted `{ state: 'done' }` would be a way around §5's requirements —
 *    an owner and a completion time — and there would be nothing to notice it.
 * 2. **The version is required to change anything.** `25-AUTH-AND-TENANT-ISOLATION` §3 step 7
 *    asks for optimistic concurrency, and the repository refuses a write that does not name
 *    the version it read. Making the token a required field rather than an optional one means
 *    a caller cannot silently opt out of it.
 * 3. **Transitions are their own sub-resource.** `POST /work-items/:id/transitions` rather
 *    than a `PATCH` with a magic field, because a transition takes *facts* the machine
 *    requires — a blocker reason, a completion time — and those belong in a body of their own
 *    rather than mixed in with a title change.
 */

interface CreateWorkItemBody {
  readonly projectId?: unknown;
  readonly title?: unknown;
  readonly description?: unknown;
  readonly type?: unknown;
  readonly ownerUserId?: unknown;
  readonly audience?: unknown;
  readonly startAt?: unknown;
  readonly dueAt?: unknown;
}

interface UpdateWorkItemBody {
  readonly version?: unknown;
  readonly title?: unknown;
  readonly description?: unknown;
  /** A6: move the item to another project of this organization. */
  readonly projectId?: unknown;
  readonly type?: unknown;
  readonly ownerUserId?: unknown;
  readonly audience?: unknown;
  readonly startAt?: unknown;
  readonly dueAt?: unknown;
  /** 52-04: `true` / `false`, or `null` to inherit the project's default. */
  readonly billable?: unknown;
  /** 53-21: story points (null | 0..100) and the iteration (null = backlog). */
  readonly points?: unknown;
  readonly iterationId?: unknown;
}

interface TransitionBody {
  readonly version?: unknown;
  readonly to?: unknown;
  /** Whatever the machine requires for this transition. Validated by it, not here. */
  readonly facts?: unknown;
}

/** `work_items.title` is `VARCHAR(300)`. */
const MAX_TITLE_LENGTH = 300;
/** `work_items.type` is `VARCHAR(32)`. */
const MAX_TYPE_LENGTH = 32;
/** A6 (0219). `work_items.description` is `TEXT`; the route bounds it well below that. */
const MAX_DESCRIPTION_LENGTH = 5000;

const AUDIENCES: readonly Audience[] = ['internal', 'client_visible', 'client_action_required'];

@Controller('v1/organizations/:orgSlug/work-items')
export class WorkItemsController {
  constructor(@Inject(WORK_ITEMS_SERVICE) private readonly workItems: WorkItemsService) {}

  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('projectId') projectId?: string,
    @Query('state') state?: string,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
  ): Promise<{ readonly workItems: readonly WorkItemView[] }> {
    const details: { field: string; message: string }[] = [];

    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1)) {
      details.push({ field: 'limit', message: 'must be a positive integer' });
    }

    // A comma-separated list, because a work list filtered to "ready or in progress" is the
    // ordinary case and repeating the parameter is not something every client library does
    // the same way.
    const states = state === undefined ? undefined : state.split(',').map((value) => value.trim());
    if (states) {
      for (const candidate of states) {
        if (!isWorkItemState(candidate)) {
          details.push({ field: 'state', message: `${candidate} is not a work item state` });
        }
      }
    }

    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The query is invalid', details);
    }

    return {
      workItems: await this.workItems.list(context, principal, {
        ...(projectId ? { projectId } : {}),
        ...(states ? { states: states as WorkItemState[] } : {}),
        ...(after ? { after } : {}),
        ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
      }),
    };
  }

  @Get(':workItemId')
  @RequireCapability('work.read')
  async get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
  ): Promise<WorkItemView> {
    return this.workItems.get(context, principal, workItemId);
  }

  @Post()
  @RequireCapability('work.create')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateWorkItemBody,
  ): Promise<WorkItemView> {
    const details: { field: string; message: string }[] = [];

    const projectId = typeof body?.projectId === 'string' ? body.projectId : undefined;
    if (!projectId) details.push({ field: 'projectId', message: 'must be a string' });

    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    if (title === '') details.push({ field: 'title', message: 'must be a non-empty string' });
    if (title.length > MAX_TITLE_LENGTH) {
      details.push({ field: 'title', message: `must be ${MAX_TITLE_LENGTH} characters or fewer` });
    }

    const type = optionalShortString(body?.type, 'type', MAX_TYPE_LENGTH, details);
    const description = optionalDescription(body?.description, details);
    const audience = optionalAudience(body?.audience, details);
    const startAt = optionalInstant(body?.startAt, 'startAt', details);
    const dueAt = optionalInstant(body?.dueAt, 'dueAt', details);
    const ownerUserId =
      typeof body?.ownerUserId === 'string' && body.ownerUserId !== ''
        ? body.ownerUserId
        : undefined;

    if (details.length > 0 || !projectId) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.workItems.create(context, principal, {
      projectId,
      title,
      ...(type === undefined ? {} : { type }),
      ...(description === undefined ? {} : { description }),
      ...(audience === undefined ? {} : { audience }),
      ...(ownerUserId === undefined ? {} : { ownerUserId }),
      ...(startAt === undefined ? {} : { startAt }),
      ...(dueAt === undefined ? {} : { dueAt }),
    });
  }

  /**
   * Change fields. Never state — see the note at the top of this file.
   *
   * `PATCH` rather than `PUT`, because a caller sends the fields they are changing and the
   * version they read. A `PUT` would require sending every field, which turns "rename this"
   * into an opportunity to blank a due date by omission.
   */
  @Patch(':workItemId')
  @RequireCapability('work.update')
  async update(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Body() body: UpdateWorkItemBody,
  ): Promise<WorkItemView & { readonly billable?: boolean | null } & WorkItemPlanningChange> {
    const details: { field: string; message: string }[] = [];
    const version = requiredVersion(body?.version, details);

    const title = optionalShortString(body?.title, 'title', MAX_TITLE_LENGTH, details);
    const type = optionalShortString(body?.type, 'type', MAX_TYPE_LENGTH, details);
    const description = optionalDescription(body?.description, details);
    const projectId = optionalShortString(body?.projectId, 'projectId', 64, details);
    const audience = optionalAudience(body?.audience, details);
    const startAt = optionalInstant(body?.startAt, 'startAt', details);
    const dueAt = optionalInstant(body?.dueAt, 'dueAt', details);
    const ownerUserId =
      body?.ownerUserId === null
        ? null
        : typeof body?.ownerUserId === 'string'
          ? body.ownerUserId
          : undefined;

    const billable = body?.billable;
    if (billable !== undefined && billable !== null && typeof billable !== 'boolean') {
      details.push({ field: 'billable', message: 'must be true, false or null' });
    }

    const planning = parsePlanningFields(body, details); // 53-21
    if (details.length > 0 || version === undefined) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.workItems.update(context, principal, workItemId, version, {
      ...planning,
      ...(billable === undefined ? {} : { billable: billable as boolean | null }),
      ...(title === undefined ? {} : { title }),
      ...(type === undefined ? {} : { type }),
      ...(description === undefined ? {} : { description }),
      ...(projectId === undefined ? {} : { projectId }),
      ...(audience === undefined ? {} : { audience }),
      ...(ownerUserId === undefined ? {} : { ownerUserId }),
      ...(startAt === undefined ? {} : { startAt }),
      ...(dueAt === undefined ? {} : { dueAt }),
    });
  }

  /**
   * Move through the lifecycle.
   *
   * `facts` is passed to the state machine untouched. This controller does not know which
   * facts each transition needs and must not learn: `packages/domain` is the one place that
   * is written, and the machine's refusal already names what was missing.
   */
  @Post(':workItemId/transitions')
  @RequireCapability('work.transition')
  @HttpCode(200)
  async transition(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Body() body: TransitionBody,
  ): Promise<WorkItemView> {
    const details: { field: string; message: string }[] = [];
    const version = requiredVersion(body?.version, details);

    const to = typeof body?.to === 'string' ? body.to : undefined;
    if (!to || !isWorkItemState(to)) {
      details.push({ field: 'to', message: 'must be a work item state' });
    }

    const facts =
      body?.facts === undefined || body.facts === null
        ? {}
        : typeof body.facts === 'object' && !Array.isArray(body.facts)
          ? (body.facts as Record<string, unknown>)
          : undefined;
    if (facts === undefined) {
      details.push({ field: 'facts', message: 'must be an object' });
    }

    if (details.length > 0 || version === undefined || !to || !isWorkItemState(to) || !facts) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.workItems.transition(context, principal, workItemId, version, to, facts);
  }

  /**
   * Soft-delete. `work.update` rather than a capability of its own, because
   * `12-PERMISSION-MATRIX` §2 does not define a separate one — and inventing a capability the
   * matrix does not list would put a permission in the code that no role can be granted.
   */
  @Delete(':workItemId')
  @RequireCapability('work.delete')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
  ): Promise<void> {
    await this.workItems.softDelete(context, principal, workItemId);
  }

  // ── WORK-003: dependencies, the blocker ledger, and the health signal ───────

  /**
   * Add an edge: this item depends on another. `work.update` rather than a capability of
   * its own, for `remove`'s reason — the matrix defines none, and an edge is a fact about
   * this row's planning.
   */
  @Post(':workItemId/dependencies')
  @RequireCapability('work.update')
  @HttpCode(201)
  async addDependency(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Body()
    body: {
      readonly dependsOnWorkItemId?: unknown;
      readonly kind?: unknown;
      readonly lagWorkingDays?: unknown;
    },
    @AuthScheme() authScheme?: string,
  ): Promise<WorkItemDependencyView> {
    if (typeof body?.dependsOnWorkItemId !== 'string' || body.dependsOnWorkItemId.trim() === '') {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'dependsOnWorkItemId', message: 'must be a work item id' },
      ]);
    }
    // 53-04: typed edge — kind (default FS), lag in working days (default 0), and who made it.
    const typed = parseTypedDependency(body, { kind: 'FS', lag: 0 });
    return this.workItems.addDependency(
      context,
      principal,
      workItemId,
      body.dependsOnWorkItemId.trim(),
      { kind: typed.kind ?? 'FS', lag: typed.lag ?? 0, source: dependencySourceOf(authScheme) },
    );
  }

  @Delete(':workItemId/dependencies/:dependencyId')
  @RequireCapability('work.update')
  @HttpCode(204)
  async removeDependency(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Param('dependencyId') dependencyId: string,
  ): Promise<void> {
    await this.workItems.removeDependency(context, principal, workItemId, dependencyId);
  }

  /** US-B04's history: every blocker this item ever had, raised and resolved, oldest first. */
  @Get(':workItemId/blockers')
  @RequireCapability('work.read')
  async listBlockers(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
  ): Promise<{ readonly blockers: readonly WorkBlockerView[] }> {
    return { blockers: await this.workItems.listBlockers(context, principal, workItemId) };
  }

  /**
   * The health signal, computed at read time. Every signal names its cause; the answer
   * says when it was computed, because a health claim without freshness is a guess.
   */
  @Get(':workItemId/health')
  @RequireCapability('work.read')
  async health(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
  ): Promise<WorkItemHealthView> {
    return this.workItems.healthOf(context, principal, workItemId);
  }

  /**
   * UNIT-12's project subject: the project's health rolled up over per-item health. Behind
   * `work.read`, the same capability every read here uses, so a caller without it is refused
   * exactly as the sibling reads refuse. Authored ready for the screen; no web surface consumes
   * it yet (recorded as the follow-up in implementation-status).
   */
  @Get('project-health/:projectId')
  @RequireCapability('work.read')
  async projectHealth(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<ProjectHealthView> {
    return this.workItems.projectHealthOf(context, principal, projectId);
  }
}

function isWorkItemState(value: string): value is WorkItemState {
  return (WORK_ITEM_STATES as readonly string[]).includes(value);
}

/**
 * The concurrency token, required rather than optional.
 *
 * Accepts a number or a numeric string, because `version` is `BIGINT UNSIGNED` and a client
 * that read it out of JSON may have kept it as either. It is refused outright when absent, so
 * a caller cannot opt out of optimistic concurrency by leaving it off.
 */
function requiredVersion(
  raw: unknown,
  details: { field: string; message: string }[],
): number | undefined {
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    details.push({ field: 'version', message: 'must be the version you read' });
    return undefined;
  }
  return value;
}

function optionalShortString(
  raw: unknown,
  field: string,
  max: number,
  details: { field: string; message: string }[],
): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.trim() === '') {
    details.push({ field, message: 'must be a non-empty string' });
    return undefined;
  }
  const value = raw.trim();
  if (value.length > max) {
    details.push({ field, message: `must be ${max} characters or fewer` });
    return undefined;
  }
  return value;
}

/**
 * A6 (0219). A description: absent leaves it alone, `null` or blank clears it, anything else is
 * trimmed and bounded. Blank-as-clear because the edit dialog sends what its box holds.
 */
function optionalDescription(
  raw: unknown,
  details: { field: string; message: string }[],
): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'string') {
    details.push({ field: 'description', message: 'must be a string or null' });
    return undefined;
  }
  const value = raw.trim();
  if (value.length > MAX_DESCRIPTION_LENGTH) {
    details.push({
      field: 'description',
      message: `must be ${MAX_DESCRIPTION_LENGTH} characters or fewer`,
    });
    return undefined;
  }
  return value === '' ? null : value;
}

function optionalAudience(
  raw: unknown,
  details: { field: string; message: string }[],
): Audience | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !(AUDIENCES as readonly string[]).includes(raw)) {
    details.push({ field: 'audience', message: `must be one of ${AUDIENCES.join(', ')}` });
    return undefined;
  }
  return raw as Audience;
}

/**
 * An instant, not a calendar date.
 *
 * `start_at` and `due_at` are `DATETIME(3)` and carry a time of day — unlike a project's
 * target date, which is a calendar date and is parsed at midnight UTC in
 * `ProjectsController`. A work item due "Friday at 5" is a real thing to express, so this
 * takes a full ISO 8601 instant and refuses a bare date rather than guessing a time for it.
 *
 * `null` is accepted and means "clear this", which is distinct from omitting the field.
 */
function optionalInstant(
  raw: unknown,
  field: string,
  details: { field: string; message: string }[],
): Date | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;

  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    details.push({ field, message: 'must be an ISO 8601 instant, such as 2026-09-30T17:00:00Z' });
    return undefined;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    details.push({ field, message: 'is not a real instant' });
    return undefined;
  }
  return parsed;
}
