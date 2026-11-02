import {
  MAX_ITERATIONS_PER_PROJECT,
  authorize,
  burndown,
  isFinishedWorkItemState,
  iterationStatusOn,
  localDateOf,
  nextFreeSlot,
  workingDaysLeft,
} from '@tmanage/domain';
import type {
  BurndownPoint,
  Capability,
  IterationPhase,
  Principal,
  WorkingCalendar,
} from '@tmanage/domain';
import type { IterationRow, WorkItemPlanningRow } from '../../common/database/schema.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import type { IterationsRepository, IterationTotals } from './iterations.repository.js';
import {
  parseComplete,
  parseCreate,
  parseMoveItems,
  parsePointsSetting,
  parseUpdate,
} from './iterations.validate.js';

/**
 * 53-21 — iterations (light sprints) and points, the member side.
 *
 * Capabilities (no new key; `schedule.manage` does not exist): create / edit / complete an
 * iteration and switch points on = `project.manage` on the project; move items in or out =
 * `work.update` on every item; reads = `work.read`. Clients never: a non-internal principal gets the
 * same 404 an absent iteration gives, and no client projection names an iteration or points.
 * 55-04 Simple/Power mode has no backend gate (the tab is the web's).
 *
 * Complete-and-roll is ONE transaction: claim the completion (a conditional UPDATE, so concurrent
 * calls serialize on the row), move every unfinished item (state not `done`/`archived`) to the
 * target iteration or the backlog, store the counts. A repeated call moves nothing and answers the
 * stored counts.
 *
 * Audit: `iteration.created`, `iteration.updated`, `iteration.items_moved` (counts, never titles),
 * `iteration.completed` ({moved, left}), `project.points_setting_changed`.
 */

export interface IterationView {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly goal: string | null;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly status: string;
  readonly phase: IterationPhase;
  readonly completedAt: string | null;
  readonly version: number;
  readonly itemCount: number;
  readonly committedPoints: number;
  readonly donePoints: number;
  readonly daysLeft: number;
}

export interface IterationListView {
  readonly projectId: string;
  readonly pointsEnabled: boolean;
  readonly iterations: readonly IterationView[];
}

export interface IterationItemView {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly points: number | null;
}

export interface IterationDetailView extends IterationView {
  readonly items: readonly IterationItemView[];
}

export interface BurndownView {
  readonly iterationId: string;
  readonly points: readonly BurndownPoint[];
}

export interface MoveItemsView {
  readonly added: number;
  readonly removed: number;
}

export interface CompleteView {
  readonly iterationId: string;
  readonly moved: number;
  readonly left: number;
  readonly movedTo: string | null;
  readonly alreadyCompleted: boolean;
}

export type IterationsRepositoryPort = Pick<
  IterationsRepository,
  | 'projectPoints'
  | 'setPointsEnabled'
  | 'listForProject'
  | 'countForProject'
  | 'findById'
  | 'insert'
  | 'update'
  | 'claimCompletion'
  | 'recordCompletionCounts'
  | 'totals'
  | 'itemsOf'
  | 'findItems'
  | 'assignItems'
>;

/** The effective working calendar of a project (its override, else the org's, else the default). */
export interface IterationCalendarSource {
  calendarFor(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<WorkingCalendar>;
}

export interface IterationsServiceOptions {
  readonly database: Pick<TenantDatabase, 'transaction' | 'read'>;
  readonly repository: IterationsRepositoryPort;
  readonly calendars: IterationCalendarSource;
  readonly audit: Pick<AuditService, 'record'>;
  readonly now?: () => Date;
}

const notFound = (): ApiError => new ApiError(404, 'not_found', MESSAGES.notFound);
const conflict = (code: string, field: string): ApiError =>
  new ApiError(409, 'conflict', MESSAGES.conflict, [{ field, message: code }]);
const unprocessable = (code: string, field: string, message: string): ApiError =>
  new ApiError(422, 'validation_failed', message, [{ field, message: code }]);

const EMPTY_TOTALS: IterationTotals = { itemCount: 0, committedPoints: 0, donePoints: 0 };

function itemResource(item: WorkItemPlanningRow) {
  return {
    organizationId: item.organizationId,
    projectId: item.projectId,
    audience: item.audience as 'internal',
    lifecycle: item.state === 'archived' ? ('archived' as const) : ('active' as const),
  };
}

export class IterationsService {
  private readonly now: () => Date;

  constructor(private readonly options: IterationsServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async list(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<IterationListView> {
    this.requireOnProject(principal, context, projectId, 'work.read');
    const repo = this.options.repository;
    return this.options.database.read(context, async (r) => {
      const project = await repo.projectPoints(r, context, projectId);
      if (project === null) throw notFound();
      const rows = await repo.listForProject(r, context, projectId, MAX_ITERATIONS_PER_PROJECT);
      const totals = await repo.totals(
        r,
        context,
        projectId,
        rows.map((row) => row.id),
      );
      const calendar = await this.options.calendars.calendarFor(r, context, projectId);
      const today = localDateOf(this.now(), calendar.timeZone);
      return {
        projectId,
        pointsEnabled: project.pointsEnabled,
        iterations: rows.map((row) =>
          toView(row, totals.get(row.id) ?? EMPTY_TOTALS, calendar, today),
        ),
      };
    });
  }

  async create(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    body: unknown,
  ): Promise<IterationView> {
    this.requireOnProject(principal, context, projectId, 'project.manage');
    const input = parseCreate(body);
    const repo = this.options.repository;
    const at = this.now();
    return this.options.database.transaction(context, async (tx) => {
      if ((await repo.projectPoints(tx, context, projectId)) === null) throw notFound();
      if ((await repo.countForProject(tx, context, projectId)) >= MAX_ITERATIONS_PER_PROJECT) {
        throw conflict('iteration_limit', 'projectId');
      }
      const calendar = await this.options.calendars.calendarFor(tx, context, projectId);
      const today = localDateOf(at, calendar.timeZone);
      let { startsOn, endsOn } = input;
      if (startsOn === null || endsOn === null) {
        const existing = await repo.listForProject(
          tx,
          context,
          projectId,
          MAX_ITERATIONS_PER_PROJECT,
        );
        ({ startsOn, endsOn } = nextFreeSlot(existing, calendar, today));
      }
      const id = await repo.insert(
        tx,
        context,
        { projectId, name: input.name, goal: input.goal, startsOn, endsOn },
        at,
      );
      await this.audit(tx, context, 'iteration.created', id, {
        project_id: projectId,
        starts_on: startsOn,
        ends_on: endsOn,
      });
      const row = await repo.findById(tx, context, id);
      if (row === null) throw new Error('iteration vanished immediately after insert');
      return toView(row, EMPTY_TOTALS, calendar, today);
    });
  }

  async get(
    context: TenantContext,
    principal: Principal,
    iterationId: string,
  ): Promise<IterationDetailView> {
    const repo = this.options.repository;
    return this.options.database.read(context, async (r) => {
      const row = await this.readable(r, context, principal, iterationId);
      const items = (await repo.itemsOf(r, context, row.projectId, iterationId)).filter(
        (item) =>
          authorize({ principal, capability: 'work.read', resource: itemResource(item) }).allowed,
      );
      const totals = await repo.totals(r, context, row.projectId, [iterationId]);
      const calendar = await this.options.calendars.calendarFor(r, context, row.projectId);
      const today = localDateOf(this.now(), calendar.timeZone);
      return {
        ...toView(row, totals.get(iterationId) ?? EMPTY_TOTALS, calendar, today),
        items: items.map((item) => ({
          id: item.id,
          title: item.title,
          state: item.state,
          points: item.points,
        })),
      };
    });
  }

  async update(
    context: TenantContext,
    principal: Principal,
    iterationId: string,
    body: unknown,
  ): Promise<IterationView> {
    const input = parseUpdate(body);
    const repo = this.options.repository;
    const at = this.now();
    return this.options.database.transaction(context, async (tx) => {
      const before = await this.readable(tx, context, principal, iterationId);
      this.requireOnProject(principal, context, before.projectId, 'project.manage');
      if (before.status === 'completed') throw conflict('completed', 'status');
      if (before.version !== input.expectedVersion) throw conflict('version_conflict', 'version');
      const { expectedVersion, ...changes } = input;
      const changed = await repo.update(tx, context, iterationId, expectedVersion, changes, at);
      if (changed === 0) throw conflict('version_conflict', 'version');
      const fields = (['name', 'goal', 'startsOn', 'endsOn'] as const).filter(
        (key) => before[key] !== changes[key],
      );
      await this.audit(tx, context, 'iteration.updated', iterationId, {
        project_id: before.projectId,
        fields: fields.join('.') || 'none',
        starts_on: changes.startsOn,
        ends_on: changes.endsOn,
      });
      const row = await repo.findById(tx, context, iterationId);
      if (row === null) throw notFound();
      const totals = await repo.totals(tx, context, row.projectId, [iterationId]);
      const calendar = await this.options.calendars.calendarFor(tx, context, row.projectId);
      return toView(
        row,
        totals.get(iterationId) ?? EMPTY_TOTALS,
        calendar,
        localDateOf(at, calendar.timeZone),
      );
    });
  }

  async burndown(
    context: TenantContext,
    principal: Principal,
    iterationId: string,
  ): Promise<BurndownView> {
    const repo = this.options.repository;
    return this.options.database.read(context, async (r) => {
      const row = await this.readable(r, context, principal, iterationId);
      const items = await repo.itemsOf(r, context, row.projectId, iterationId);
      const calendar = await this.options.calendars.calendarFor(r, context, row.projectId);
      return {
        iterationId,
        points: burndown({
          iteration: { startsOn: row.startsOn, endsOn: row.endsOn },
          items: items.map((item) => ({
            points: item.points,
            assignedAt: item.iterationAssignedAt,
            completedAt: isFinishedWorkItemState(item.state) ? item.completedAt : null,
          })),
          calendar,
        }),
      };
    });
  }

  async moveItems(
    context: TenantContext,
    principal: Principal,
    iterationId: string,
    body: unknown,
  ): Promise<MoveItemsView> {
    const input = parseMoveItems(body);
    const repo = this.options.repository;
    const at = this.now();
    return this.options.database.transaction(context, async (tx) => {
      const iteration = await this.readable(tx, context, principal, iterationId);
      if (iteration.status === 'completed' && input.add.length > 0) {
        throw conflict('completed', 'status');
      }
      const named = [...input.add, ...input.remove];
      const items = await repo.findItems(tx, context, named);
      if (items.length !== named.length) throw notFound();
      for (const item of items) {
        const verdict = authorize({
          principal,
          capability: 'work.update',
          resource: itemResource(item),
        });
        if (!verdict.allowed) {
          throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, verdict.code);
        }
        if (item.projectId !== iteration.projectId) {
          throw unprocessable(
            'cross_project',
            'add',
            'Every work item must be in the iteration’s project',
          );
        }
      }
      const removing = items
        .filter((item) => input.remove.includes(item.id) && item.iterationId === iterationId)
        .map((item) => item.id);
      const adding = items
        .filter((item) => input.add.includes(item.id) && item.iterationId !== iterationId)
        .map((item) => item.id);
      await repo.assignItems(tx, context, adding, iterationId, at);
      await repo.assignItems(tx, context, removing, null, at);
      await this.audit(tx, context, 'iteration.items_moved', iterationId, {
        project_id: iteration.projectId,
        added: adding.length,
        removed: removing.length,
      });
      return { added: adding.length, removed: removing.length };
    });
  }

  async complete(
    context: TenantContext,
    principal: Principal,
    iterationId: string,
    body: unknown,
  ): Promise<CompleteView> {
    const { moveUnfinishedTo } = parseComplete(body);
    const repo = this.options.repository;
    const at = this.now();
    return this.options.database.transaction(context, async (tx) => {
      const iteration = await this.readable(tx, context, principal, iterationId);
      this.requireOnProject(principal, context, iteration.projectId, 'project.manage');
      if (iteration.status === 'completed') return stored(iteration);
      if (moveUnfinishedTo !== null) {
        const target = await repo.findById(tx, context, moveUnfinishedTo);
        if (
          target === null ||
          target.id === iterationId ||
          target.projectId !== iteration.projectId ||
          target.status === 'completed'
        ) {
          throw unprocessable(
            'invalid_target',
            'moveUnfinishedTo',
            'Unfinished work can move only to another open iteration of the same project',
          );
        }
      }
      if ((await repo.claimCompletion(tx, context, iterationId, at)) === 0) {
        const now = await repo.findById(tx, context, iterationId);
        if (now === null) throw notFound();
        return stored(now);
      }
      const items = await repo.itemsOf(tx, context, iteration.projectId, iterationId);
      const unfinished = items
        .filter((item) => !isFinishedWorkItemState(item.state))
        .map((i) => i.id);
      const left = items.length - unfinished.length;
      await repo.assignItems(tx, context, unfinished, moveUnfinishedTo, at);
      await repo.recordCompletionCounts(tx, context, iterationId, unfinished.length, left);
      await this.audit(tx, context, 'iteration.completed', iterationId, {
        project_id: iteration.projectId,
        moved: unfinished.length,
        left,
        moved_to: moveUnfinishedTo ?? 'backlog',
      });
      return {
        iterationId,
        moved: unfinished.length,
        left,
        movedTo: moveUnfinishedTo,
        alreadyCompleted: false,
      };
    });
  }

  /** Switch story points on or off for a project (`project.manage`). */
  async setPointsEnabled(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    body: unknown,
  ): Promise<{ readonly projectId: string; readonly pointsEnabled: boolean }> {
    this.requireOnProject(principal, context, projectId, 'project.manage');
    const enabled = parsePointsSetting(body);
    const repo = this.options.repository;
    return this.options.database.transaction(context, async (tx) => {
      const project = await repo.projectPoints(tx, context, projectId);
      if (project === null) throw notFound();
      if (project.pointsEnabled !== enabled) {
        await repo.setPointsEnabled(tx, context, projectId, enabled);
        await this.audit(tx, context, 'project.points_setting_changed', projectId, {
          points_before: project.pointsEnabled,
          points_after: enabled,
        });
      }
      return { projectId, pointsEnabled: enabled };
    });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** The iteration, if this internal principal may read its project; otherwise 404. */
  private async readable(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    iterationId: string,
  ): Promise<IterationRow> {
    const row = await this.options.repository.findById(runner, context, iterationId);
    if (row === null) throw notFound();
    this.requireOnProject(principal, context, row.projectId, 'work.read');
    return row;
  }

  private requireOnProject(
    principal: Principal,
    context: TenantContext,
    projectId: string,
    capability: Capability,
  ): void {
    // Clients never see iterations: the same 404 as an iteration that does not exist.
    if (principal.kind !== 'internal') throw notFound();
    const verdict = authorize({
      principal,
      capability,
      resource: {
        organizationId: context.organizationId,
        projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      if (capability === 'work.read') throw notFound();
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, verdict.code);
    }
  }

  private async audit(
    tx: TenantQueryRunner,
    context: TenantContext,
    action:
      | 'iteration.created'
      | 'iteration.updated'
      | 'iteration.items_moved'
      | 'iteration.completed'
      | 'project.points_setting_changed',
    objectId: string,
    metadata: Readonly<Record<string, string | number | boolean | null>>,
  ): Promise<void> {
    await this.options.audit.record(tx, context, {
      action,
      result: 'allowed',
      objectId,
      actorUserId: context.userId,
      metadata,
    });
  }
}

function stored(row: IterationRow): CompleteView {
  return {
    iterationId: row.id,
    moved: row.movedCount ?? 0,
    left: row.leftCount ?? 0,
    movedTo: null,
    alreadyCompleted: true,
  };
}

function toView(
  row: IterationRow,
  totals: IterationTotals,
  calendar: WorkingCalendar,
  today: string,
): IterationView {
  const span = { startsOn: row.startsOn, endsOn: row.endsOn, status: row.status };
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    goal: row.goal,
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    status: row.status,
    phase: iterationStatusOn(span, today),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    version: row.version,
    itemCount: totals.itemCount,
    committedPoints: totals.committedPoints,
    donePoints: totals.donePoints,
    daysLeft: row.status === 'completed' ? 0 : workingDaysLeft(span, calendar, today),
  };
}
