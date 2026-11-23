import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../../common/database/drizzle.js';
import {
  workItems,
  workStageSetProjects,
  workStageSets,
  workStages,
} from '../../../common/database/schema.js';
import type { WorkStageRow, WorkStageSetRow } from '../../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../../common/database/tenant-context.js';
import { MAX_STAGE_SETS_PER_WORKSPACE, MAX_STAGES_PER_SET } from './stage-rules.js';

/**
 * Work area D1 (0413) — the storage half of stage sets. The one writer of `work_stage_sets`,
 * `work_stages` and `work_stage_set_projects` (AR-11). Every statement is bound to the tenant
 * (DA-12); the repository holds no policy. The two `work_items` columns the stages use are written
 * by `WorkItemsRepository`, never here; this file only reads them (counts for the 409s).
 */

export interface StageSetWithStages {
  readonly set: WorkStageSetRow;
  readonly stages: readonly WorkStageRow[];
}

export interface NewStage {
  readonly name: string;
  readonly stateKey: string;
  readonly colorKey: string | null;
  readonly position: number;
}

/** Which set a work uses, and where that choice came from. */
export type StageSetSource = 'work' | 'project' | 'workspace' | 'builtin';

export interface EffectiveSet {
  readonly source: StageSetSource;
  /** `null` for the built-in set. */
  readonly set: StageSetWithStages | null;
}

/** The smallest work row the resolution needs. */
export interface WorkStageRef {
  readonly id: string;
  readonly projectId: string;
  readonly stageSetId?: string | null;
}

export class WorkStagesRepository {
  // ── stage sets ────────────────────────────────────────────────────────────

  async listSets(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly StageSetWithStages[]> {
    const sets = await tenantDrizzle(runner)
      .select()
      .from(workStageSets)
      .where(eq(workStageSets.organizationId, context.organizationId))
      .orderBy(asc(workStageSets.name), asc(workStageSets.id))
      .limit(MAX_STAGE_SETS_PER_WORKSPACE);
    return this.withStages(runner, context, sets);
  }

  async findSet(
    runner: TenantQueryRunner,
    context: TenantContext,
    setId: string,
  ): Promise<StageSetWithStages | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(workStageSets)
      .where(
        and(eq(workStageSets.organizationId, context.organizationId), eq(workStageSets.id, setId)),
      )
      .limit(1);
    const [found] = await this.withStages(runner, context, rows);
    return found ?? null;
  }

  async findSetByName(
    runner: TenantQueryRunner,
    context: TenantContext,
    name: string,
  ): Promise<WorkStageSetRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(workStageSets)
      .where(
        and(eq(workStageSets.organizationId, context.organizationId), eq(workStageSets.name, name)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async countSets(runner: TenantQueryRunner, context: TenantContext): Promise<number> {
    const rows = await tenantDrizzle(runner)
      .select({ n: sql<number>`count(*)` })
      .from(workStageSets)
      .where(eq(workStageSets.organizationId, context.organizationId));
    return Number(rows[0]?.n ?? 0);
  }

  async insertSet(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: {
      readonly name: string;
      readonly scope: string;
      readonly projectId: string | null;
      readonly stages: readonly NewStage[];
    },
    now: Date,
  ): Promise<string> {
    const id = uuidv7();
    await tenantDrizzle(runner).insert(workStageSets).values({
      id,
      organizationId: context.organizationId,
      name: input.name,
      scope: input.scope,
      projectId: input.projectId,
      defaultMarker: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    for (const stage of input.stages) await this.insertStage(runner, context, id, stage, now);
    return id;
  }

  /** Compare-and-set on `version` (DA-1): `false` when another write came first. */
  async updateSet(
    runner: TenantQueryRunner,
    context: TenantContext,
    setId: string,
    expectedVersion: number,
    patch: { readonly name?: string },
    now: Date,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(workStageSets)
      .set({
        ...(patch.name === undefined ? {} : { name: patch.name }),
        version: sql`${workStageSets.version} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(workStageSets.organizationId, context.organizationId),
          eq(workStageSets.id, setId),
          eq(workStageSets.version, expectedVersion),
        ),
      );
    return result[0].affectedRows > 0;
  }

  /** A stage changed: the set's version moves too, so a stale editor sees the change. */
  async touchSet(
    runner: TenantQueryRunner,
    context: TenantContext,
    setId: string,
    now: Date,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(workStageSets)
      .set({ version: sql`${workStageSets.version} + 1`, updatedAt: now })
      .where(
        and(eq(workStageSets.organizationId, context.organizationId), eq(workStageSets.id, setId)),
      );
  }

  /** Make `setId` the workspace default (or clear the default when `null`). */
  async setDefault(
    runner: TenantQueryRunner,
    context: TenantContext,
    setId: string | null,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(workStageSets)
      .set({ defaultMarker: null })
      .where(
        and(
          eq(workStageSets.organizationId, context.organizationId),
          eq(workStageSets.defaultMarker, 1),
        ),
      );
    if (setId === null) return;
    await tenantDrizzle(runner)
      .update(workStageSets)
      .set({ defaultMarker: 1 })
      .where(
        and(eq(workStageSets.organizationId, context.organizationId), eq(workStageSets.id, setId)),
      );
  }

  async deleteSet(runner: TenantQueryRunner, context: TenantContext, setId: string): Promise<void> {
    const db = tenantDrizzle(runner);
    await db
      .delete(workStages)
      .where(
        and(
          eq(workStages.organizationId, context.organizationId),
          eq(workStages.stageSetId, setId),
        ),
      );
    await db
      .delete(workStageSetProjects)
      .where(
        and(
          eq(workStageSetProjects.organizationId, context.organizationId),
          eq(workStageSetProjects.stageSetId, setId),
        ),
      );
    await db
      .delete(workStageSets)
      .where(
        and(eq(workStageSets.organizationId, context.organizationId), eq(workStageSets.id, setId)),
      );
  }

  // ── stages ────────────────────────────────────────────────────────────────

  async insertStage(
    runner: TenantQueryRunner,
    context: TenantContext,
    setId: string,
    stage: NewStage,
    now: Date,
  ): Promise<string> {
    const id = uuidv7();
    await tenantDrizzle(runner).insert(workStages).values({
      id,
      organizationId: context.organizationId,
      stageSetId: setId,
      name: stage.name,
      stateKey: stage.stateKey,
      colorKey: stage.colorKey,
      position: stage.position,
      createdAt: now,
    });
    return id;
  }

  async updateStage(
    runner: TenantQueryRunner,
    context: TenantContext,
    stageId: string,
    patch: {
      readonly name?: string;
      readonly stateKey?: string;
      readonly colorKey?: string | null;
    },
  ): Promise<void> {
    if (Object.keys(patch).length === 0) return;
    await tenantDrizzle(runner)
      .update(workStages)
      .set(patch)
      .where(
        and(eq(workStages.organizationId, context.organizationId), eq(workStages.id, stageId)),
      );
  }

  async setPositions(
    runner: TenantQueryRunner,
    context: TenantContext,
    setId: string,
    stageIds: readonly string[],
  ): Promise<void> {
    for (const [index, stageId] of stageIds.entries()) {
      await tenantDrizzle(runner)
        .update(workStages)
        .set({ position: index })
        .where(
          and(
            eq(workStages.organizationId, context.organizationId),
            eq(workStages.stageSetId, setId),
            eq(workStages.id, stageId),
          ),
        );
    }
  }

  async deleteStage(
    runner: TenantQueryRunner,
    context: TenantContext,
    stageId: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .delete(workStages)
      .where(
        and(eq(workStages.organizationId, context.organizationId), eq(workStages.id, stageId)),
      );
  }

  // ── project links ─────────────────────────────────────────────────────────

  async projectSetId(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<string | null> {
    const rows = await tenantDrizzle(runner)
      .select({ setId: workStageSetProjects.stageSetId })
      .from(workStageSetProjects)
      .where(
        and(
          eq(workStageSetProjects.organizationId, context.organizationId),
          eq(workStageSetProjects.projectId, projectId),
        ),
      )
      .limit(1);
    return rows[0]?.setId ?? null;
  }

  /** Point a project at a set (`null` = back to the workspace's). Idempotent upsert. */
  async linkProject(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    setId: string | null,
    now: Date,
  ): Promise<void> {
    const db = tenantDrizzle(runner);
    if (setId === null) {
      await db
        .delete(workStageSetProjects)
        .where(
          and(
            eq(workStageSetProjects.organizationId, context.organizationId),
            eq(workStageSetProjects.projectId, projectId),
          ),
        );
      return;
    }
    await db
      .insert(workStageSetProjects)
      .values({
        organizationId: context.organizationId,
        projectId,
        stageSetId: setId,
        updatedAt: now,
      })
      .onDuplicateKeyUpdate({ set: { stageSetId: setId, updatedAt: now } });
  }

  /** How many projects and how many works name this set directly (the delete 409). */
  async usage(
    runner: TenantQueryRunner,
    context: TenantContext,
    setId: string,
  ): Promise<{ readonly projects: number; readonly works: number }> {
    const db = tenantDrizzle(runner);
    const projects = await db
      .select({ n: sql<number>`count(*)` })
      .from(workStageSetProjects)
      .where(
        and(
          eq(workStageSetProjects.organizationId, context.organizationId),
          eq(workStageSetProjects.stageSetId, setId),
        ),
      );
    const works = await db
      .select({ n: sql<number>`count(*)` })
      .from(workItems)
      .where(
        and(
          eq(workItems.organizationId, context.organizationId),
          eq(workItems.stageSetId, setId),
          isNull(workItems.deletedAt),
        ),
      );
    return { projects: Number(projects[0]?.n ?? 0), works: Number(works[0]?.n ?? 0) };
  }

  /**
   * How many live works that use this set are in `state` — the set itself, a project linked to
   * it (works without their own set), or, for the workspace default, every work with neither.
   */
  async worksOnSetInState(
    runner: TenantQueryRunner,
    context: TenantContext,
    setId: string,
    isDefault: boolean,
    state: string,
  ): Promise<number> {
    const link = workStageSetProjects;
    const rows = await tenantDrizzle(runner)
      .select({ n: sql<number>`count(*)` })
      .from(workItems)
      .leftJoin(
        link,
        and(
          eq(link.organizationId, workItems.organizationId),
          eq(link.projectId, workItems.projectId),
        ),
      )
      .where(
        and(
          eq(workItems.organizationId, context.organizationId),
          isNull(workItems.deletedAt),
          eq(workItems.state, state as never),
          or(
            eq(workItems.stageSetId, setId),
            and(
              isNull(workItems.stageSetId),
              isDefault
                ? or(eq(link.stageSetId, setId), isNull(link.stageSetId))
                : eq(link.stageSetId, setId),
            ),
          ),
        ),
      );
    return Number(rows[0]?.n ?? 0);
  }

  /** How many live works of a project, without their own set, are in `state`. */
  async projectWorksInState(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    state: string,
  ): Promise<number> {
    const rows = await tenantDrizzle(runner)
      .select({ n: sql<number>`count(*)` })
      .from(workItems)
      .where(
        and(
          eq(workItems.organizationId, context.organizationId),
          eq(workItems.projectId, projectId),
          isNull(workItems.stageSetId),
          isNull(workItems.deletedAt),
          eq(workItems.state, state as never),
        ),
      );
    return Number(rows[0]?.n ?? 0);
  }

  async defaultSet(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<StageSetWithStages | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(workStageSets)
      .where(
        and(
          eq(workStageSets.organizationId, context.organizationId),
          eq(workStageSets.defaultMarker, 1),
        ),
      )
      .limit(1);
    const [found] = await this.withStages(runner, context, rows);
    return found ?? null;
  }

  // ── resolution ────────────────────────────────────────────────────────────

  /** The set one work uses: its own, else its project's, else the workspace default, else built-in. */
  async effectiveFor(
    runner: TenantQueryRunner,
    context: TenantContext,
    work: WorkStageRef,
  ): Promise<EffectiveSet> {
    const resolved = await this.effectiveForMany(runner, context, [work]);
    return resolved.get(work.id) ?? { source: 'builtin', set: null };
  }

  /** The set each work uses, in a fixed number of reads however many works there are. */
  async effectiveForMany(
    runner: TenantQueryRunner,
    context: TenantContext,
    works: readonly WorkStageRef[],
  ): Promise<ReadonlyMap<string, EffectiveSet>> {
    const out = new Map<string, EffectiveSet>();
    if (works.length === 0) return out;
    const db = tenantDrizzle(runner);
    const projectIds = [...new Set(works.map((work) => work.projectId))];
    const links = await db
      .select({ projectId: workStageSetProjects.projectId, setId: workStageSetProjects.stageSetId })
      .from(workStageSetProjects)
      .where(
        and(
          eq(workStageSetProjects.organizationId, context.organizationId),
          inArray(workStageSetProjects.projectId, projectIds),
        ),
      );
    const projectSet = new Map(links.map((row) => [row.projectId, row.setId]));
    const wanted = new Set<string>();
    for (const work of works) {
      if (work.stageSetId) wanted.add(work.stageSetId);
    }
    for (const setId of projectSet.values()) wanted.add(setId);
    const sets = await db
      .select()
      .from(workStageSets)
      .where(
        and(
          eq(workStageSets.organizationId, context.organizationId),
          wanted.size === 0
            ? eq(workStageSets.defaultMarker, 1)
            : or(inArray(workStageSets.id, [...wanted]), eq(workStageSets.defaultMarker, 1)),
        ),
      );
    const loaded = new Map(
      (await this.withStages(runner, context, sets)).map((entry) => [entry.set.id, entry]),
    );
    const fallback = [...loaded.values()].find((entry) => entry.set.defaultMarker === 1) ?? null;
    for (const work of works) {
      const own = work.stageSetId ? loaded.get(work.stageSetId) : undefined;
      if (own) {
        out.set(work.id, { source: 'work', set: own });
        continue;
      }
      const linked = projectSet.get(work.projectId);
      const project = linked ? loaded.get(linked) : undefined;
      if (project) {
        out.set(work.id, { source: 'project', set: project });
        continue;
      }
      out.set(
        work.id,
        fallback ? { source: 'workspace', set: fallback } : { source: 'builtin', set: null },
      );
    }
    return out;
  }

  private async withStages(
    runner: TenantQueryRunner,
    context: TenantContext,
    sets: readonly WorkStageSetRow[],
  ): Promise<StageSetWithStages[]> {
    if (sets.length === 0) return [];
    const stages = await tenantDrizzle(runner)
      .select()
      .from(workStages)
      .where(
        and(
          eq(workStages.organizationId, context.organizationId),
          inArray(
            workStages.stageSetId,
            sets.map((set) => set.id),
          ),
        ),
      )
      .orderBy(asc(workStages.position), asc(workStages.id))
      .limit(sets.length * MAX_STAGES_PER_SET);
    return sets.map((set) => ({
      set,
      stages: stages.filter((stage) => stage.stageSetId === set.id),
    }));
  }
}
