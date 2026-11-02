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
} from '@nestjs/common';
import { authorize, clientStatusOf, isInternalRole } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { MILESTONE_LIFECYCLE_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { MembershipsRepository } from '../tenancy/memberships.repository.js';
import { ClientOrganizationsRepository } from './client-organizations.repository.js';
import { ProjectClientsRepository } from './project-clients.repository.js';
import { ProjectMilestonesRepository } from './project-milestones.repository.js';
import { MAX_PROJECTIONS_PER_PROJECT } from './project-milestones.repository.js';
import type { UpdateProjectMilestonePatch } from './project-milestones.repository.js';
import {
  toMilestonePublication,
  toProjectMilestoneView,
  toTimelineMilestoneInput,
} from './project-milestones.projection.js';
import type { MilestonePublication } from './project-milestones.projection.js';
import type { ProjectMilestoneView } from './project-milestones.controller.js';
import type { AuditService } from '../audit/audit.service.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import type { ProjectMilestoneRow } from '../../common/database/schema.js';
import type { TenantQueryRunner } from '../../common/database/tenant-context.js';

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
  /** 53-07. The date promised to the client. */
  readonly committedOn?: string | null;
  /** 53-07. The internal forecast. */
  readonly forecastOn?: string | null;
  /** 53-07. Manual timeline order. */
  readonly timelineOrder?: number | null;
  /** 53-07. The client-safe name the published copy uses. */
  readonly clientTitle?: string | null;
  /** 53-07. Send it back as `expectedVersion` on the next edit. */
  readonly version?: number;
}

/**
 * A9 — one milestone as the Milestones list and Edit milestone read it (`project.manage`, internal).
 *
 * The edit view's fields plus the two A9 columns (0222): "what is delivered" and the owner. Like
 * {@link MilestoneEditView} it never leaves the internal `projects` path.
 */
export interface MilestoneDetailView {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  /** "What is delivered"; null when not written. */
  readonly description: string | null;
  /** A 'YYYY-MM-DD' target day, or null when the date is not committed. */
  readonly dueOn: string | null;
  readonly status: ProjectMilestoneView['status'];
  /** "Show on the client timeline". */
  readonly published: boolean;
  readonly ownerUserId: string | null;
  /** An ISO-8601 instant — for a met milestone, when it was marked done. */
  readonly updatedAt: string;
}

/** A9 — the project's milestone plan: every milestone, and the client that would see it. */
export interface MilestonePlanView {
  /** The name of the client company the project is shared with, or null for an internal project. */
  readonly clientName: string | null;
  readonly milestones: readonly MilestoneDetailView[];
}

/** `project_milestones.title` is VARCHAR(300). */
const MAX_MILESTONE_TITLE_LENGTH = 300;

/** A9: "What is delivered" is a sentence or two, not a document. */
const MAX_MILESTONE_DESCRIPTION_LENGTH = 2000;

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
  /** 53-07. The version the editor last read; a mismatch is 409 `version_conflict`. */
  readonly expectedVersion?: number;
  /**
   * 53-07. Why the committed date moved, in words a client may read. Required (422
   * `reason_required`) when the milestone is published and `committedOn` changes. Stored only in
   * the `milestone.date_changed` audit row's before/after, never on the milestone.
   */
  readonly clientSafeReason?: string;
}

/** 53-07. The client-safe reason is a sentence, not a document. */
const MAX_REASON_LENGTH = 500;

/** 53-07. Today as a civil UTC day, for the client status a copy carries. */
const TODAY = (): string => new Date().toISOString().slice(0, 10);

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
    private readonly members: MembershipsRepository = new MembershipsRepository(),
    private readonly shares: ProjectClientsRepository = new ProjectClientsRepository(),
    private readonly clientOrganizations: ClientOrganizationsRepository = new ClientOrganizationsRepository(),
    /** 53-07. `milestone.date_changed`, `milestone.published`, `milestone.unpublished`. */
    private readonly audit?: AuditService,
    /** 53-07. `milestone.published.v1`. */
    private readonly outbox?: OutboxEventsRepository,
  ) {}

  /**
   * A9 — the project's milestones with their details, and the client company that sees the
   * published ones. Same resolve-then-authorize order as {@link edit}.
   */
  async plan(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<MilestonePlanView> {
    await this.resolveManageable(context, principal, projectId);

    return this.database.read(context, async (runner) => {
      const rows = await this.milestones.list(runner, context, { projectId, publishedOnly: false });
      const [share] = await this.shares.list(runner, context, { projectId, limit: 1 });
      const client = share
        ? await this.clientOrganizations.findById(runner, context, share.clientOrganizationId)
        : null;
      return { clientName: client?.name ?? null, milestones: rows.map(toMilestoneDetailView) };
    });
  }

  /**
   * A9 — delete a milestone (`project.manage`). Refused with 409 while a dependency edge, a retro
   * note or a phase placement still names it, so a delete never strands a link.
   */
  async remove(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    milestoneId: string,
  ): Promise<void> {
    await this.resolveManageable(context, principal, projectId);
    await this.resolveMilestone(context, projectId, milestoneId);

    await this.database.transaction(context, async (tx) => {
      const links = await this.milestones.countLinks(tx, context, milestoneId);
      if (links > 0) {
        throw new ApiError(
          409,
          'conflict',
          'This milestone is still linked to other work',
          undefined,
          'milestone_in_use',
        );
      }
      await this.milestones.delete(tx, context, milestoneId);
    });
  }

  /** A9 — the owner must be an active internal member of this tenant; otherwise a 400. */
  private async requireOwner(context: TenantContext, ownerUserId: string): Promise<void> {
    const membership = await this.database.read(context, (runner) =>
      this.members.findByUserId(runner, context, ownerUserId),
    );
    if (!membership || membership.status !== 'active' || !isInternalRole(membership.role)) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'ownerUserId', message: 'must be an active member of this organization' },
      ]);
    }
  }

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
    if (typeof input.patch.ownerUserId === 'string') {
      await this.requireOwner(context, input.patch.ownerUserId);
    }

    const timelineEdit =
      input.expectedVersion !== undefined || input.patch.committedOn !== undefined;
    const row = await this.database.transaction(context, async (tx) => {
      if (!timelineEdit) return this.milestones.update(tx, context, input.milestoneId, input.patch);
      return this.editTimeline(tx, context, input);
    });
    if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound);

    return toMilestoneEditView(row);
  }

  /**
   * 53-07. A timeline edit inside the caller's transaction: lock the row, check the version, demand
   * a client-safe reason when a published milestone's committed date moves, write, keep the client
   * copy's date and status in step, and audit the move with before/after and the reason.
   */
  private async editTimeline(
    tx: TenantQueryRunner,
    context: TenantContext,
    input: EditMilestoneCommand,
  ): Promise<ProjectMilestoneRow | null> {
    const current = await this.milestones.findByIdForUpdate(tx, context, input.milestoneId);
    if (!current) return null;
    if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
      throw new ApiError(
        409,
        'conflict',
        'This milestone was changed by someone else. Reload and try again.',
        undefined,
        'version_conflict',
      );
    }

    const dateMoves =
      input.patch.committedOn !== undefined && input.patch.committedOn !== current.committedOn;
    const projection = dateMoves
      ? await this.milestones.findProjection(tx, context, input.milestoneId)
      : null;
    if (projection && !input.clientSafeReason) {
      throw new ApiError(
        422,
        'validation_failed',
        'Say why the date moved — the client will see it',
        [{ field: 'clientSafeReason', message: 'is required when a published date moves' }],
        'reason_required',
      );
    }

    const row = await this.milestones.update(tx, context, input.milestoneId, input.patch);
    if (!row || !dateMoves) return row;

    if (projection) {
      await this.milestones.upsertProjection(tx, context, {
        projectId: row.projectId,
        milestoneId: row.id,
        clientTitle: projection.clientTitle,
        committedOn: row.committedOn,
        status: clientStatusOf(toTimelineMilestoneInput(row, null), TODAY()),
        phaseName: projection.phaseName,
      });
    }
    await this.audit?.record(tx, context, {
      action: 'milestone.date_changed',
      result: 'allowed',
      objectId: row.id,
      metadata: { project_id: row.projectId, had_projection: projection !== null },
      changes: [
        { field: 'committed_on', before: current.committedOn, after: row.committedOn },
        ...(input.clientSafeReason
          ? [{ field: 'client_safe_reason', before: null, after: input.clientSafeReason }]
          : []),
      ],
    });
    return row;
  }

  /**
   * 53-07. Publish a milestone to the client timeline — ONE transaction: copy only the allowlisted
   * columns into `milestone_client_projections` (client title ?? title, committed date, the client
   * status, the phase name), set the old `published` flag for the older readers, audit and emit.
   * A re-publish refreshes the copy. At most {@link MAX_PROJECTIONS_PER_PROJECT} per project.
   */
  async publish(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    milestoneId: string,
  ): Promise<MilestonePublication> {
    await this.resolveManageable(context, principal, projectId);
    await this.resolveMilestone(context, projectId, milestoneId);

    const copy = await this.database.transaction(context, async (tx) => {
      const row = await this.milestones.findByIdForUpdate(tx, context, milestoneId);
      if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      const existing = await this.milestones.findProjection(tx, context, milestoneId);
      if (
        !existing &&
        (await this.milestones.countProjections(tx, context, projectId)) >=
          MAX_PROJECTIONS_PER_PROJECT
      ) {
        throw new ApiError(
          409,
          'conflict',
          `A project can show at most ${MAX_PROJECTIONS_PER_PROJECT} milestones to its client`,
          undefined,
          'projection_limit',
        );
      }
      const phaseName = await this.milestones.phaseNameOf(tx, context, milestoneId);
      const status = clientStatusOf(toTimelineMilestoneInput(row, null), TODAY());
      const projection = await this.milestones.upsertProjection(tx, context, {
        projectId,
        milestoneId,
        clientTitle: row.clientTitle ?? row.title,
        committedOn: row.committedOn,
        status,
        phaseName,
      });
      if (!row.published) {
        await this.milestones.update(tx, context, milestoneId, { published: true });
      }
      await this.audit?.record(tx, context, {
        action: 'milestone.published',
        result: 'allowed',
        objectId: milestoneId,
        metadata: { project_id: projectId, status, refreshed: existing !== null },
      });
      await this.outbox?.append(tx, context, {
        type: 'milestone.published.v1',
        aggregateId: milestoneId,
        payload: { milestoneId, projectId },
      });
      return projection;
    });

    return toMilestonePublication(copy);
  }

  /** 53-07. Remove the client copy (and the old flag), audited. Idempotent: no copy is still 204. */
  async unpublish(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    milestoneId: string,
  ): Promise<void> {
    await this.resolveManageable(context, principal, projectId);
    await this.resolveMilestone(context, projectId, milestoneId);

    await this.database.transaction(context, async (tx) => {
      const existing = await this.milestones.findProjection(tx, context, milestoneId);
      await this.milestones.deleteProjection(tx, context, milestoneId);
      await this.milestones.update(tx, context, milestoneId, { published: false });
      await this.audit?.record(tx, context, {
        action: 'milestone.unpublished',
        result: 'allowed',
        objectId: milestoneId,
        metadata: { project_id: projectId, had_projection: existing !== null },
      });
    });
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
  const patch: {
    title?: string;
    dueOn?: string | null;
    description?: string | null;
    ownerUserId?: string | null;
    published?: boolean;
  } = {};

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

  parseA9Fields(record, patch, details);
  const timeline = parseTimelineFields(record, details);

  if (details.length > 0) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
  }
  const merged: UpdateProjectMilestonePatch = { ...patch, ...timeline.patch };
  if (Object.keys(merged).length === 0) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'title', message: 'provide at least one field to edit' },
    ]);
  }

  return {
    projectId,
    milestoneId,
    patch: merged,
    ...(timeline.expectedVersion === undefined
      ? {}
      : { expectedVersion: timeline.expectedVersion }),
    ...(timeline.clientSafeReason === undefined
      ? {}
      : { clientSafeReason: timeline.clientSafeReason }),
  };
}

/** 53-07 — `committedOn`, `forecastOn`, `timelineOrder`, `clientTitle`, `expectedVersion`, reason. */
function parseTimelineFields(
  record: Record<string, unknown>,
  details: { field: string; message: string }[],
): {
  patch: {
    committedOn?: string | null;
    forecastOn?: string | null;
    timelineOrder?: number | null;
    clientTitle?: string | null;
  };
  expectedVersion?: number;
  clientSafeReason?: string;
} {
  const patch: {
    committedOn?: string | null;
    forecastOn?: string | null;
    timelineOrder?: number | null;
    clientTitle?: string | null;
  } = {};
  for (const field of ['committedOn', 'forecastOn'] as const) {
    if (!(field in record)) continue;
    const raw = record[field];
    if (raw === null) patch[field] = null;
    else if (typeof raw === 'string' && DUE_ON_PATTERN.test(raw)) patch[field] = raw;
    else details.push({ field, message: 'must be a YYYY-MM-DD date or null' });
  }
  if ('timelineOrder' in record) {
    const raw = record['timelineOrder'];
    if (raw === null) patch.timelineOrder = null;
    else if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 && raw <= 1_000_000)
      patch.timelineOrder = raw;
    else
      details.push({ field: 'timelineOrder', message: 'must be a non-negative integer or null' });
  }
  if ('clientTitle' in record) {
    const raw = record['clientTitle'];
    if (raw === null || (typeof raw === 'string' && raw.trim() === '')) patch.clientTitle = null;
    else if (typeof raw === 'string' && raw.trim().length <= MAX_MILESTONE_TITLE_LENGTH)
      patch.clientTitle = raw.trim();
    else
      details.push({
        field: 'clientTitle',
        message: `must be a string of ${MAX_MILESTONE_TITLE_LENGTH} characters or fewer, or null`,
      });
  }
  let expectedVersion: number | undefined;
  if ('expectedVersion' in record) {
    const raw = record['expectedVersion'];
    if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 1) expectedVersion = raw;
    else details.push({ field: 'expectedVersion', message: 'must be a positive integer' });
  }
  let clientSafeReason: string | undefined;
  if ('clientSafeReason' in record && record['clientSafeReason'] !== null) {
    const raw = record['clientSafeReason'];
    if (typeof raw === 'string' && raw.trim().length <= MAX_REASON_LENGTH) {
      if (raw.trim() !== '') clientSafeReason = raw.trim();
    } else {
      details.push({
        field: 'clientSafeReason',
        message: `must be a string of ${MAX_REASON_LENGTH} characters or fewer`,
      });
    }
  }
  return {
    patch,
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
    ...(clientSafeReason === undefined ? {} : { clientSafeReason }),
  };
}

/** A9 — `description` (string or null), `ownerUserId` (id or null) and `published` (boolean). */
function parseA9Fields(
  record: Record<string, unknown>,
  patch: { description?: string | null; ownerUserId?: string | null; published?: boolean },
  details: { field: string; message: string }[],
): void {
  if ('description' in record) {
    const raw = record['description'];
    if (raw === null || (typeof raw === 'string' && raw.trim() === '')) {
      patch.description = null;
    } else if (typeof raw === 'string' && raw.trim().length <= MAX_MILESTONE_DESCRIPTION_LENGTH) {
      patch.description = raw.trim();
    } else {
      details.push({
        field: 'description',
        message: `must be a string of ${MAX_MILESTONE_DESCRIPTION_LENGTH} characters or fewer`,
      });
    }
  }
  if ('ownerUserId' in record) {
    const raw = record['ownerUserId'];
    if (raw === null) patch.ownerUserId = null;
    else if (typeof raw === 'string' && raw !== '' && raw.length <= 36) patch.ownerUserId = raw;
    else details.push({ field: 'ownerUserId', message: 'must be a user id or null' });
  }
  if ('published' in record) {
    const raw = record['published'];
    if (typeof raw === 'boolean') patch.published = raw;
    else details.push({ field: 'published', message: 'must be a boolean' });
  }
}

/** A9 — the detail view, built field by field. */
function toMilestoneDetailView(
  row: Parameters<typeof toProjectMilestoneView>[0],
): MilestoneDetailView {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    description: row.description,
    dueOn: row.dueOn,
    status: row.status,
    published: row.published,
    ownerUserId: row.ownerUserId,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The internal edit view — the full record plus `updatedAt`. Built field by field. */
function toMilestoneEditView(row: Parameters<typeof toProjectMilestoneView>[0]): MilestoneEditView {
  return {
    ...toProjectMilestoneView(row),
    updatedAt: row.updatedAt.toISOString(),
    committedOn: row.committedOn ?? null,
    forecastOn: row.forecastOn ?? null,
    timelineOrder: row.timelineOrder ?? null,
    clientTitle: row.clientTitle ?? null,
    version: row.version,
  };
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

  /** A9 — the Milestones list and Edit milestone read. */
  @Get(':projectId/milestone-plan')
  @RequireCapability('project.manage')
  async plan(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<MilestonePlanView> {
    return this.lifecycle.plan(context, principal, projectId);
  }

  /** A9 — "Delete milestone". 409 while anything still links to it. */
  @Delete(':projectId/milestones/:id')
  @RequireCapability('project.manage')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Param('id') milestoneId: string,
  ): Promise<void> {
    await this.lifecycle.remove(context, principal, projectId, milestoneId);
  }

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

  /**
   * 53-07. Publish the milestone to the client timeline: copies only the allowlisted columns.
   * `project.manage` (`client_projection.publish` is not a capability key).
   */
  @Post(':projectId/milestones/:id/publish')
  @RequireCapability('project.manage')
  @HttpCode(200)
  async publish(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Param('id') milestoneId: string,
  ): Promise<MilestonePublication> {
    return this.lifecycle.publish(context, principal, projectId, milestoneId);
  }

  /** 53-07. Remove the milestone from the client timeline (deletes the copy). `project.manage`. */
  @Delete(':projectId/milestones/:id/publish')
  @RequireCapability('project.manage')
  @HttpCode(204)
  async unpublish(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Param('id') milestoneId: string,
  ): Promise<void> {
    await this.lifecycle.unpublish(context, principal, projectId, milestoneId);
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
