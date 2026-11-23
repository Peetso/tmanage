import { authorize } from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../../common/database/tenant-context.js';
import type { WorkStageRow } from '../../../common/database/schema.js';
import type { AuditService } from '../../audit/audit.service.js';
import { ProjectsRepository } from '../../projects/projects.repository.js';
import { WorkItemsRepository } from '../work-items.repository.js';
import type { WorkItemView, WorkItemsService } from '../work-items.service.js';
import { WorkStagesRepository } from './stages.repository.js';
import type { StageSetSource, StageSetWithStages } from './stages.repository.js';
import {
  BUILT_IN_SET_ID,
  BUILT_IN_STAGES,
  MAX_STAGE_NAME_LENGTH,
  MAX_STAGE_SETS_PER_WORKSPACE,
  MAX_STAGES_PER_SET,
  STAGE_COLOR_KEYS,
  STAGE_STATE_KEYS,
  checkSetRules,
  groupOfState,
  isPermutationOf,
  isStageColorKey,
  isStageStateKey,
  ordered,
  setCoversState,
  type StageGroup,
  type StageLike,
} from './stage-rules.js';

type StageSetUsage = Awaited<ReturnType<WorkStagesRepository['usageCounts']>>;

/**
 * Work area D1 (2026-11-23) — renamable stages and own stage sets for the workspace, a project or
 * a single work. The application service: it holds the policy, the repositories hold none.
 *
 * - **Who may change what.** A workspace set (no `projectId`) is a workspace setting:
 *   `org.manage`. A project's own set (`scope = 'project'`) belongs to that project: its managers
 *   change it (`project.manage` on that project, the evaluator's narrowing). Reading any set is
 *   `work.read`, which no client role holds. Every id is resolved tenant-scoped first, so another
 *   tenant's id is the same 404 an absent one gives, before any decision or write.
 * - **The set rules** (`stage-rules.ts`) hold after every change: ≥ 1 "Not started", ≥ 1 "In
 *   progress", exactly 1 "Done", at most 30 stages.
 * - **No work loses its place.** A change that would leave live works in `internal_review` with
 *   no "In review" stage is a 409 ("move that work first"). Works on a deleted stage move to the
 *   stage the caller names (same state) or to the derived one.
 * - **Moving a work** runs the existing transition when the stage has another state
 *   (`WorkItemsService.transition`, so the machine, the supervisor rule and the audit hold),
 *   and a same-state stage change otherwise.
 *
 * Every write is audited in its own transaction (DA-11), with identifiers and counts only.
 */

export interface StageView {
  readonly id: string;
  readonly name: string;
  readonly stateKey: string;
  readonly group: StageGroup;
  readonly colorKey: string | null;
  readonly position: number;
  /** Live works on this stage: they move when it is deleted (Figma W9 "3 work items will move"). */
  readonly workCount: number;
}

export interface StageSetView {
  readonly id: string;
  readonly name: string;
  readonly scope: string;
  /** The project a `project` set belongs to; `null` otherwise. */
  readonly projectId: string | null;
  readonly isDefault: boolean;
  /** The built-in stages a workspace without its own set uses; never stored, never editable. */
  readonly isBuiltIn: boolean;
  readonly version: number;
  /** Projects pointed at this set (Figma W7 "Used by 3 projects"); the default's others inherit it. */
  readonly projectCount: number;
  readonly stages: readonly StageView[];
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

/** The set a project (or one work) uses, and where that choice comes from. */
export interface EffectiveStageSetView {
  readonly source: StageSetSource;
  readonly stageSet: StageSetView;
}

export interface NewStageInput {
  readonly name: string;
  readonly stateKey: string;
  readonly colorKey?: string | null;
}

export interface CreateStageSetInput {
  readonly name: string;
  readonly projectId?: string;
  readonly isDefault?: boolean;
  /** The stages in order; omitted = a copy of the built-in stages. */
  readonly stages?: readonly NewStageInput[];
}

const BAD = (field: string, message: string): ApiError =>
  new ApiError(400, 'validation_failed', 'The request body is invalid', [{ field, message }]);

export class WorkStagesService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly workItemsService: Pick<
      WorkItemsService,
      'get' | 'transition' | 'changeStage' | 'changeStageSet'
    >,
    private readonly audit?: AuditService,
    private readonly stages: WorkStagesRepository = new WorkStagesRepository(),
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
    private readonly workItems: WorkItemsRepository = new WorkItemsRepository(),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  // ── reads ─────────────────────────────────────────────────────────────────

  async listSets(context: TenantContext): Promise<readonly StageSetView[]> {
    return this.database.read(context, async (runner) =>
      this.withUsage(runner, context, await this.stages.listSets(runner, context)),
    );
  }

  async getSet(context: TenantContext, setId: string): Promise<StageSetView> {
    const [view] = await this.database.read(context, async (runner) => {
      const set = await this.stages.findSet(runner, context, setId);
      return set ? this.withUsage(runner, context, [set]) : [];
    });
    if (!view) throw notFound();
    return view;
  }

  /** The set a project uses: its own, else the workspace default, else the built-in stages. */
  async projectSet(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<EffectiveStageSetView> {
    return this.database.read(context, async (runner) => {
      await this.requireProject(runner, context, principal, projectId, 'work.read');
      const linked = await this.stages.projectSetId(runner, context, projectId);
      const own = linked ? await this.stages.findSet(runner, context, linked) : null;
      const chosen = own ?? (await this.stages.defaultSet(runner, context));
      const [view] = chosen ? await this.withUsage(runner, context, [chosen]) : [];
      if (!view) return { source: 'builtin' as const, stageSet: BUILT_IN_SET_VIEW };
      return { source: own ? ('project' as const) : ('workspace' as const), stageSet: view };
    });
  }

  /** The views of these sets with their use counts, read in the same unit of work. */
  private async withUsage(
    runner: TenantQueryRunner,
    context: TenantContext,
    sets: readonly StageSetWithStages[],
  ): Promise<StageSetView[]> {
    const usage = await this.stages.usageCounts(runner, context, sets);
    return sets.map((entry) => toSetView(entry, usage));
  }

  // ── set writes ────────────────────────────────────────────────────────────

  async createSet(
    context: TenantContext,
    principal: Principal,
    input: CreateStageSetInput,
  ): Promise<StageSetView> {
    const name = requiredName(input.name, 'name');
    const stages = (input.stages ?? BUILT_IN_STAGES).map((stage, index) => ({
      name: requiredName(stage.name, `stages[${index}].name`),
      stateKey: requiredStateKey(stage.stateKey, `stages[${index}].stateKey`),
      colorKey: optionalColor((stage as NewStageInput).colorKey, `stages[${index}].colorKey`),
      position: index,
    }));
    requireRules(stages.map((stage, index) => ({ ...stage, id: String(index) })));
    requireUniqueNames(stages.map((stage) => stage.name));
    if (input.projectId !== undefined && input.isDefault === true) {
      throw BAD('isDefault', 'a project’s own stage set cannot be the workspace default');
    }
    const now = this.clock();
    const id = await this.database.transaction(context, async (tx) => {
      let previous: string | null = null;
      if (input.projectId !== undefined) {
        await this.requireProject(tx, context, principal, input.projectId, 'project.manage');
        previous = await this.stages.projectSetId(tx, context, input.projectId);
      } else {
        requireOrgManage(principal, context);
      }
      if ((await this.stages.countSets(tx, context)) >= MAX_STAGE_SETS_PER_WORKSPACE) {
        throw new ApiError(
          409,
          'conflict',
          `A workspace holds at most ${MAX_STAGE_SETS_PER_WORKSPACE} stage sets`,
        );
      }
      if (await this.stages.findSetByName(tx, context, name)) throw duplicateSetName();
      const scope =
        input.projectId !== undefined
          ? 'project'
          : input.isDefault === true
            ? 'workspace'
            : 'custom';
      const created = await this.stages.insertSet(
        tx,
        context,
        { name, scope, projectId: input.projectId ?? null, stages },
        now,
      );
      if (input.isDefault === true) await this.stages.setDefault(tx, context, created);
      // A project's own set is the set that project uses, from the start.
      if (input.projectId !== undefined) {
        await this.stages.linkProject(tx, context, input.projectId, created, now);
        await this.workItems.repointStage(
          tx,
          context,
          await this.stageIdsOf(tx, context, previous),
          null,
          { projectId: input.projectId },
        );
      }
      await this.audit?.record(tx, context, {
        action: 'work_stage_set.created',
        objectId: created,
        result: 'allowed',
        metadata: {
          stages: stages.length,
          is_default: input.isDefault === true,
          ...(input.projectId === undefined ? {} : { project_id: input.projectId }),
        },
      });
      return created;
    });
    return this.getSet(context, id);
  }

  async updateSet(
    context: TenantContext,
    principal: Principal,
    setId: string,
    input: { readonly version: number; readonly name?: string; readonly isDefault?: boolean },
  ): Promise<StageSetView> {
    const name = input.name === undefined ? undefined : requiredName(input.name, 'name');
    const now = this.clock();
    await this.database.transaction(context, async (tx) => {
      const current = await this.requireSetForWrite(tx, context, principal, setId);
      if (input.isDefault !== undefined && current.set.projectId !== null) {
        throw BAD('isDefault', 'a project’s own stage set cannot be the workspace default');
      }
      if (input.isDefault !== undefined) requireOrgManage(principal, context);
      if (name !== undefined && name !== current.set.name) {
        const clash = await this.stages.findSetByName(tx, context, name);
        if (clash && clash.id !== setId) throw duplicateSetName();
      }
      const wasDefault = current.set.defaultMarker === 1;
      if (input.isDefault === false && wasDefault) {
        // The built-in stages take over: refuse when that would strand works in review.
        await this.requireNoStrandedReview(tx, context, current, BUILT_IN_STAGES);
      }
      const ok = await this.stages.updateSet(
        tx,
        context,
        setId,
        input.version,
        { ...(name === undefined ? {} : { name }) },
        now,
      );
      if (!ok) throw versionConflict();
      if (input.isDefault !== undefined && input.isDefault !== wasDefault) {
        // Works that inherit the default start over at the derived stage of what takes over.
        const previous = await this.stages.defaultSet(tx, context);
        if (input.isDefault && previous) {
          await this.requireNoStrandedReview(tx, context, previous, current.stages);
        }
        await this.stages.setDefault(tx, context, input.isDefault ? setId : null);
        await this.workItems.repointStage(
          tx,
          context,
          previous ? previous.stages.map((stage) => stage.id) : [],
          null,
        );
      }
      await this.audit?.record(tx, context, {
        action: 'work_stage_set.changed',
        objectId: setId,
        result: 'allowed',
        metadata: {
          renamed: name !== undefined && name !== current.set.name,
          ...(input.isDefault === undefined ? {} : { is_default: input.isDefault }),
        },
      });
    });
    return this.getSet(context, setId);
  }

  async deleteSet(context: TenantContext, principal: Principal, setId: string): Promise<void> {
    await this.database.transaction(context, async (tx) => {
      const current = await this.requireSetForWrite(tx, context, principal, setId);
      const usage = await this.stages.usage(tx, context, setId);
      const ownProject = current.set.projectId;
      // A project's own set may go while only its project uses it; anything else in use is a 409.
      const otherProjects = ownProject === null ? usage.projects : Math.max(0, usage.projects - 1);
      if (otherProjects > 0 || usage.works > 0) {
        throw new ApiError(
          409,
          'conflict',
          'Projects or works still use this stage set. Give them other stages first.',
          [
            { field: 'projects', message: String(usage.projects) },
            { field: 'works', message: String(usage.works) },
          ],
          'stage_set_in_use',
        );
      }
      const isDefault = current.set.defaultMarker === 1;
      if (isDefault || ownProject !== null) {
        // What takes over (the built-in stages, or the workspace's) must hold works in review.
        const next = isDefault
          ? BUILT_IN_STAGES
          : ((await this.stages.defaultSet(tx, context))?.stages ?? BUILT_IN_STAGES);
        await this.requireNoStrandedReview(tx, context, current, next);
      }
      const moved = await this.workItems.repointStage(
        tx,
        context,
        current.stages.map((stage) => stage.id),
        null,
      );
      await this.stages.deleteSet(tx, context, setId);
      await this.audit?.record(tx, context, {
        action: 'work_stage_set.deleted',
        objectId: setId,
        result: 'allowed',
        metadata: { was_default: isDefault, works_moved: moved },
      });
    });
  }

  // ── stage writes ──────────────────────────────────────────────────────────

  async addStage(
    context: TenantContext,
    principal: Principal,
    setId: string,
    input: NewStageInput & { readonly position?: number },
  ): Promise<StageSetView> {
    const name = requiredName(input.name, 'name');
    const stateKey = requiredStateKey(input.stateKey, 'stateKey');
    const colorKey = optionalColor(input.colorKey, 'colorKey');
    const now = this.clock();
    await this.database.transaction(context, async (tx) => {
      const current = await this.requireSetForWrite(tx, context, principal, setId);
      if (current.stages.some((stage) => stage.name === name)) throw duplicateStageName();
      const inOrder = ordered(current.stages);
      const at =
        input.position === undefined
          ? inOrder.length
          : requiredPosition(input.position, inOrder.length);
      const next = [
        ...inOrder.slice(0, at),
        { id: 'new', name, stateKey, position: at },
        ...inOrder.slice(at),
      ];
      requireRules(next);
      const id = await this.stages.insertStage(
        tx,
        context,
        setId,
        { name, stateKey, colorKey, position: at },
        now,
      );
      await this.stages.setPositions(
        tx,
        context,
        setId,
        next.map((stage) => (stage.id === 'new' ? id : stage.id)),
      );
      await this.stages.touchSet(tx, context, setId, now);
      await this.auditChange(tx, context, setId, 'stage_added', id);
    });
    return this.getSet(context, setId);
  }

  async updateStage(
    context: TenantContext,
    principal: Principal,
    setId: string,
    stageId: string,
    input: {
      readonly name?: string;
      readonly stateKey?: string;
      readonly colorKey?: string | null;
    },
  ): Promise<StageSetView> {
    const name = input.name === undefined ? undefined : requiredName(input.name, 'name');
    const stateKey =
      input.stateKey === undefined ? undefined : requiredStateKey(input.stateKey, 'stateKey');
    const colorKey =
      input.colorKey === undefined ? undefined : optionalColor(input.colorKey, 'colorKey');
    const now = this.clock();
    await this.database.transaction(context, async (tx) => {
      const current = await this.requireSetForWrite(tx, context, principal, setId);
      const stage = requireStage(current, stageId);
      if (name !== undefined && current.stages.some((s) => s.id !== stageId && s.name === name)) {
        throw duplicateStageName();
      }
      if (stateKey !== undefined && stateKey !== stage.stateKey) {
        const next = current.stages.map((s) => (s.id === stageId ? { ...s, stateKey } : s));
        requireRules(next);
        // A stage that holds works cannot change state under them: move the work first.
        if ((await this.workItems.countOnStages(tx, context, [stageId])) > 0) {
          throw stageInUse();
        }
        await this.requireNoStrandedReview(tx, context, current, next);
      }
      await this.stages.updateStage(tx, context, stageId, {
        ...(name === undefined ? {} : { name }),
        ...(stateKey === undefined ? {} : { stateKey }),
        ...(colorKey === undefined ? {} : { colorKey }),
      });
      await this.stages.touchSet(tx, context, setId, now);
      await this.auditChange(tx, context, setId, 'stage_changed', stageId);
    });
    return this.getSet(context, setId);
  }

  async deleteStage(
    context: TenantContext,
    principal: Principal,
    setId: string,
    stageId: string,
    moveToStageId: string | undefined,
  ): Promise<StageSetView> {
    const now = this.clock();
    await this.database.transaction(context, async (tx) => {
      const current = await this.requireSetForWrite(tx, context, principal, setId);
      const stage = requireStage(current, stageId);
      const rest = current.stages.filter((s) => s.id !== stageId);
      requireRules(rest);
      let target: string | null = null;
      if (moveToStageId !== undefined) {
        const to = rest.find((s) => s.id === moveToStageId);
        if (!to || to.stateKey !== stage.stateKey) {
          throw new ApiError(
            422,
            'validation_failed',
            'Works can only move to another stage of this set with the same state',
            [
              {
                field: 'moveToStageId',
                message: 'must be a stage of this set with the same state',
              },
            ],
            'stage_move_target_invalid',
          );
        }
        target = to.id;
      }
      await this.requireNoStrandedReview(tx, context, current, rest);
      const moved = await this.workItems.repointStage(tx, context, [stageId], target);
      await this.stages.deleteStage(tx, context, stageId);
      await this.stages.setPositions(
        tx,
        context,
        setId,
        ordered(rest).map((s) => s.id),
      );
      await this.stages.touchSet(tx, context, setId, now);
      await this.auditChange(tx, context, setId, 'stage_deleted', stageId, moved);
    });
    return this.getSet(context, setId);
  }

  async reorderStages(
    context: TenantContext,
    principal: Principal,
    setId: string,
    stageIds: readonly string[],
  ): Promise<StageSetView> {
    const now = this.clock();
    await this.database.transaction(context, async (tx) => {
      const current = await this.requireSetForWrite(tx, context, principal, setId);
      if (!isPermutationOf(stageIds, current.stages)) {
        throw BAD('stageIds', 'must list every stage of this set exactly once');
      }
      await this.stages.setPositions(tx, context, setId, stageIds);
      await this.stages.touchSet(tx, context, setId, now);
      await this.auditChange(tx, context, setId, 'stages_reordered', setId);
    });
    return this.getSet(context, setId);
  }

  // ── project and work ──────────────────────────────────────────────────────

  /** Point a project at a set (`null` = the workspace's). `project.manage` on the project. */
  async setProjectSet(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    stageSetId: string | null,
  ): Promise<EffectiveStageSetView> {
    const now = this.clock();
    await this.database.transaction(context, async (tx) => {
      await this.requireProject(tx, context, principal, projectId, 'project.manage');
      const before = await this.stages.projectSetId(tx, context, projectId);
      let next: readonly StageLike[];
      if (stageSetId === null) {
        next = (await this.stages.defaultSet(tx, context))?.stages ?? BUILT_IN_STAGES;
      } else {
        const set = await this.stages.findSet(tx, context, stageSetId);
        if (!set) throw notFound('stage_set_not_found');
        if (set.set.projectId !== null && set.set.projectId !== projectId) {
          throw new ApiError(
            422,
            'validation_failed',
            'That stage set belongs to another project',
            [{ field: 'stageSetId', message: 'must be a workspace set or this project’s own' }],
            'stage_set_other_project',
          );
        }
        next = set.stages;
      }
      if (
        !setCoversStateFor(next, 'internal_review') &&
        (await this.stages.projectWorksInState(tx, context, projectId, 'internal_review')) > 0
      ) {
        throw strandedReview();
      }
      if (before !== stageSetId) {
        await this.stages.linkProject(tx, context, projectId, stageSetId, now);
        await this.workItems.repointStage(
          tx,
          context,
          await this.stageIdsOf(tx, context, before),
          null,
          { projectId },
        );
        await this.audit?.record(tx, context, {
          action: 'project.stage_set_changed',
          objectId: projectId,
          result: 'allowed',
          metadata: {
            stage_set_before: before ?? 'workspace',
            stage_set_after: stageSetId ?? 'workspace',
          },
        });
      }
    });
    return this.projectSet(context, principal, projectId);
  }

  /**
   * Move a work to a stage. Another state: the ordinary transition (machine, supervisor rule,
   * audit) landing on this stage. The same state: a stage change. `facts` go to the machine.
   */
  async moveWork(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    input: {
      readonly stageId: string;
      readonly version: number;
      readonly facts: Readonly<Record<string, unknown>>;
    },
  ): Promise<WorkItemView> {
    // The read decides visibility (404); the write below decides the right to change it.
    const work = await this.workItemsService.get(context, principal, workItemId);
    const stage = await this.database.read(context, async (runner) => {
      const row = await this.workItems.findById(runner, context, workItemId);
      const resolved = row ? await this.stages.effectiveFor(runner, context, row) : null;
      const stages = resolved?.set?.stages ?? BUILT_IN_STAGES;
      return stages.find((candidate) => candidate.id === input.stageId) ?? null;
    });
    if (!stage) {
      throw new ApiError(
        422,
        'validation_failed',
        'That stage is not one of the stages this work uses',
        [{ field: 'stageId', message: 'must be a stage of this work’s stage set' }],
        'stage_not_in_stage_set',
      );
    }
    if (stage.stateKey === work.state) {
      return this.workItemsService.changeStage(
        context,
        principal,
        workItemId,
        input.version,
        stage.id,
      );
    }
    if (!isStageStateKey(stage.stateKey)) throw notFound();
    return this.workItemsService.transition(
      context,
      principal,
      workItemId,
      input.version,
      stage.stateKey,
      input.facts,
      { stageId: stage.id },
    );
  }

  /** Give one work its own set (`null` = its project's). */
  async setWorkSet(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    input: { readonly stageSetId: string | null; readonly version: number },
  ): Promise<WorkItemView> {
    return this.workItemsService.changeStageSet(
      context,
      principal,
      workItemId,
      input.version,
      input.stageSetId,
    );
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /** Resolve a set tenant-scoped (404), then decide who may change it (403). */
  private async requireSetForWrite(
    tx: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    setId: string,
  ): Promise<StageSetWithStages> {
    const set = await this.stages.findSet(tx, context, setId);
    if (!set) throw notFound('stage_set_not_found');
    if (set.set.projectId !== null) {
      await this.requireProject(tx, context, principal, set.set.projectId, 'project.manage');
    } else {
      requireOrgManage(principal, context);
    }
    return set;
  }

  /** A project the caller cannot read is a 404; one they read but may not change is a 403. */
  private async requireProject(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    projectId: string,
    capability: Capability,
  ): Promise<void> {
    const row = await this.projects.findById(runner, context, projectId);
    const resource = row
      ? {
          organizationId: row.organizationId,
          projectId: row.id,
          audience: 'internal' as const,
          lifecycle: 'active' as const,
        }
      : null;
    if (!resource || !authorize({ principal, capability: 'work.read', resource }).allowed) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
    }
    const verdict = authorize({ principal, capability, resource });
    if (!verdict.allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, verdict.code);
    }
  }

  /**
   * 409 when live works using `current` sit in `internal_review` and `next` (what they would use
   * after the change) has no "In review" stage. The other groups are always present (set rules).
   */
  private async requireNoStrandedReview(
    tx: TenantQueryRunner,
    context: TenantContext,
    current: StageSetWithStages,
    next: readonly StageLike[],
  ): Promise<void> {
    if (setCoversStateFor(next, 'internal_review')) return;
    const inReview = await this.stages.worksOnSetInState(
      tx,
      context,
      current.set.id,
      current.set.defaultMarker === 1,
      'internal_review',
    );
    if (inReview > 0) throw strandedReview();
  }

  /** The stage ids of a set, or of the workspace default when `setId` is `null`. */
  private async stageIdsOf(
    tx: TenantQueryRunner,
    context: TenantContext,
    setId: string | null,
  ): Promise<string[]> {
    const set = setId
      ? await this.stages.findSet(tx, context, setId)
      : await this.stages.defaultSet(tx, context);
    return set ? set.stages.map((stage) => stage.id) : [];
  }

  private async auditChange(
    tx: TenantQueryRunner,
    context: TenantContext,
    setId: string,
    change: 'stage_added' | 'stage_changed' | 'stage_deleted' | 'stages_reordered',
    stageId: string,
    worksMoved?: number,
  ): Promise<void> {
    await this.audit?.record(tx, context, {
      action: 'work_stage_set.changed',
      objectId: setId,
      result: 'allowed',
      metadata: {
        change,
        stage_id: stageId,
        ...(worksMoved === undefined ? {} : { works_moved: worksMoved }),
      },
    });
  }
}

// ── projections and small rules ──────────────────────────────────────────────

function toStageView(stage: WorkStageRow | StageLike, workCount = 0): StageView {
  return {
    id: stage.id,
    name: stage.name,
    stateKey: stage.stateKey,
    group: groupOfState(stage.stateKey) ?? 'not_started',
    colorKey: 'colorKey' in stage ? (stage.colorKey ?? null) : null,
    position: stage.position,
    workCount,
  };
}

function toSetView(entry: StageSetWithStages, usage: StageSetUsage): StageSetView {
  return {
    id: entry.set.id,
    name: entry.set.name,
    scope: entry.set.scope,
    projectId: entry.set.projectId ?? null,
    isDefault: entry.set.defaultMarker === 1,
    isBuiltIn: false,
    version: Number(entry.set.version),
    projectCount: usage.projectsBySet.get(entry.set.id) ?? 0,
    stages: ordered(entry.stages).map((stage) =>
      toStageView(stage, usage.worksByStage.get(stage.id) ?? 0),
    ),
    createdAt: entry.set.createdAt.toISOString(),
    updatedAt: entry.set.updatedAt.toISOString(),
  };
}

const BUILT_IN_SET_VIEW: StageSetView = {
  id: BUILT_IN_SET_ID,
  name: 'Default',
  scope: 'workspace',
  projectId: null,
  isDefault: true,
  isBuiltIn: true,
  version: 0,
  projectCount: 0,
  stages: BUILT_IN_STAGES.map((stage) => toStageView(stage)),
  createdAt: null,
  updatedAt: null,
};

function setCoversStateFor(stages: readonly StageLike[], state: string): boolean {
  return setCoversState(stages, state);
}

function requireOrgManage(principal: Principal, context: TenantContext): void {
  const verdict = authorize({
    principal,
    capability: 'org.manage',
    resource: {
      organizationId: context.organizationId,
      projectId: null,
      audience: 'internal',
      lifecycle: 'active',
    },
  });
  if (!verdict.allowed) {
    throw new ApiError(
      403,
      'forbidden',
      MESSAGES.forbidden,
      undefined,
      `work_stage_sets.manage:${verdict.code}`,
    );
  }
}

function requireStage(set: StageSetWithStages, stageId: string): WorkStageRow {
  const stage = set.stages.find((candidate) => candidate.id === stageId);
  if (!stage) throw notFound('stage_not_found');
  return stage;
}

function requireRules(stages: readonly StageLike[]): void {
  const broken = checkSetRules(stages);
  if (broken) {
    throw new ApiError(
      422,
      'validation_failed',
      broken.message,
      [{ field: 'stages', message: broken.message }],
      `stage_set_${broken.rule}`,
    );
  }
}

function requireUniqueNames(names: readonly string[]): void {
  if (new Set(names).size !== names.length) throw duplicateStageName();
}

function requiredName(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') throw BAD(field, 'must be a non-empty string');
  const name = raw.trim();
  if (name.length > MAX_STAGE_NAME_LENGTH) {
    throw BAD(field, `must be ${MAX_STAGE_NAME_LENGTH} characters or fewer`);
  }
  return name;
}

function requiredStateKey(raw: unknown, field: string): string {
  if (!isStageStateKey(raw)) throw BAD(field, `must be one of: ${STAGE_STATE_KEYS.join(', ')}`);
  return raw;
}

function optionalColor(raw: unknown, field: string): string | null {
  if (raw === undefined || raw === null) return null;
  if (!isStageColorKey(raw)) throw BAD(field, `must be one of: ${STAGE_COLOR_KEYS.join(', ')}`);
  return raw;
}

function requiredPosition(raw: unknown, max: number): number {
  if (
    typeof raw !== 'number' ||
    !Number.isInteger(raw) ||
    raw < 0 ||
    raw > Math.min(max, MAX_STAGES_PER_SET)
  ) {
    throw BAD('position', `must be an integer between 0 and ${max}`);
  }
  return raw;
}

function notFound(code?: string): ApiError {
  return new ApiError(404, 'not_found', MESSAGES.notFound, undefined, code);
}

function versionConflict(): ApiError {
  return new ApiError(409, 'conflict', MESSAGES.conflict, [
    { field: 'version', message: 'the stage set changed since you read it' },
  ]);
}

function duplicateSetName(): ApiError {
  return new ApiError(
    409,
    'conflict',
    'A stage set with this name already exists',
    [{ field: 'name', message: 'must be unique within the workspace' }],
    'duplicate_stage_set_name',
  );
}

function duplicateStageName(): ApiError {
  return new ApiError(
    409,
    'conflict',
    'A stage with this name already exists in this set',
    [{ field: 'name', message: 'must be unique within the set' }],
    'duplicate_stage_name',
  );
}

function stageInUse(): ApiError {
  return new ApiError(
    409,
    'conflict',
    'Works are on this stage. Move them to another stage first.',
    undefined,
    'stage_in_use',
  );
}

function strandedReview(): ApiError {
  return new ApiError(
    409,
    'conflict',
    'Some works are in review and these stages have no "In review" stage. Move that work first.',
    undefined,
    'stage_set_strands_review',
  );
}
