import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { isDependencyKind, uuidv7 } from '@tmanage/domain';
import type { Audience, DependencyKind, DependencySource } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  memberships,
  projects,
  workBlockers,
  workItemDependencies,
  workItems,
} from '../../common/database/schema.js';
import type { WorkBlockerRow, WorkItemDependencyRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { unwrapQueryError } from '../../common/database/query-error.js';

/**
 * WORK-003's storage: the edges between work items, and the blocker ledger.
 *
 * Same shape as every repository here — `TenantContext` scopes, no input carries an
 * `organizationId` — with two rules of its own:
 *
 * ## The cycle rule runs before the insert, under a project-row lock (53-04)
 *
 * A self-edge is refused by 0011's trigger; a longer cycle cannot be seen from one row, so the
 * service locks both ends' project rows ({@link WorkGraphRepository.lockProjects}), reads the
 * active edges downstream of the edited item ({@link WorkGraphRepository.listActiveEdgesFrom})
 * and runs the domain's `findCycle` before the insert: if the edited item can already reach the
 * proposed predecessor, the new edge would close a loop and "on track" would mean nothing for
 * either. The walk is level-by-level scoped SELECTs rather than one recursive CTE, deliberately.
 *
 * ## Blockers are raised and resolved, never edited
 *
 * The engine owns the invariants (0011): one active blocker per item via the generated
 * column's unique key, resolution written exactly once and whole. This class translates
 * the collision into {@link WorkItemAlreadyBlockedError} and otherwise stays out of the
 * trigger's way.
 */

export class DependencyCycleError extends Error {
  constructor(
    readonly workItemId: string,
    readonly dependsOnWorkItemId: string,
    /** 53-04: the loop, successor first, as `findCycle` names it. */
    readonly path: readonly string[] = [],
  ) {
    super(`Depending on ${dependsOnWorkItemId} would create a cycle`);
    this.name = 'DependencyCycleError';
  }
}

export class DuplicateDependencyError extends Error {
  constructor() {
    super('That dependency already exists');
    this.name = 'DuplicateDependencyError';
  }
}

export class SelfDependencyError extends Error {
  constructor() {
    super('A work item cannot depend on itself');
    this.name = 'SelfDependencyError';
  }
}

export class WorkItemAlreadyBlockedError extends Error {
  constructor(readonly workItemId: string) {
    super(`Work item ${workItemId} already has an active blocker`);
    this.name = 'WorkItemAlreadyBlockedError';
  }
}

interface MysqlErrorShape {
  readonly code?: string;
}

/** Drizzle wraps driver errors; unwrap before reading the driver's own code or message. */
function isDuplicateKey(error: unknown): boolean {
  return (unwrapQueryError(error) as MysqlErrorShape | null)?.code === 'ER_DUP_ENTRY';
}

function isSignalled(error: unknown, fragment: string): boolean {
  const cause = unwrapQueryError(error);
  return cause instanceof Error && cause.message.includes(fragment);
}

/**
 * A predecessor with the facts the health signal reads.
 *
 * `projectId` and `audience` carry each predecessor's own authorization inputs, because a
 * dependency can be linked across projects (an org-wide admin can, and access can be revoked
 * after the edge is made). The health service authorizes each predecessor against these
 * before it discloses the identifying `title`, `workItemId` or `dueAt` — R01 in the
 * 12 September code review, F3 in the tenant-isolation audit.
 */
export interface PredecessorHealthRow {
  readonly dependencyId: string;
  readonly workItemId: string;
  readonly projectId: string;
  readonly audience: Audience;
  readonly title: string;
  readonly state: string;
  readonly dueAt: Date | null;
  readonly deletedAt: Date | null;
}

/** 53-04. An active typed edge, as the cycle guard and the cascade read it. */
export interface TypedEdgeRow {
  readonly id: string;
  readonly workItemId: string;
  readonly dependsOnWorkItemId: string;
  readonly kind: DependencyKind;
  readonly lag: number;
}

export interface TypedDependencyInput {
  readonly kind: DependencyKind;
  readonly lag: number;
  readonly source: DependencySource;
}

/** The most items one graph walk visits; a plan larger than this is cut, never looped over. */
export const MAX_GRAPH_NODES = 2000;

function toTypedEdge(row: {
  id: string;
  workItemId: string;
  dependsOnWorkItemId: string;
  kind: string;
  lag: number;
}): TypedEdgeRow {
  // An unrecognised kind (none can be written: the service checks) reads as the old meaning, FS.
  return { ...row, kind: isDependencyKind(row.kind) ? row.kind : 'FS', lag: Number(row.lag) };
}

export class WorkGraphRepository {
  // ── Dependencies ───────────────────────────────────────────────────────────

  /**
   * 53-04. Lock the project rows of both ends of a proposed edge, ascending id order, before any
   * read of the graph. Two concurrent inserts touching the same project therefore serialise, and
   * the second one's cycle walk sees the first one's committed edge — the row lock replaces the
   * plan's after-the-fact integrity sweep. It must be the transaction's first statement, so the
   * walk's consistent reads are taken after the lock is held.
   */
  async lockProjects(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectIds: readonly string[],
  ): Promise<void> {
    const ids = [...new Set(projectIds)].sort();
    if (ids.length === 0) return;
    await tenantDrizzle(runner)
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.organizationId, context.organizationId), inArray(projects.id, ids)))
      .orderBy(asc(projects.id))
      .for('update');
  }

  /**
   * The active edges downstream of `rootId` (every edge out of a reached item), plus every active
   * edge into a reached item — exactly what a cycle check from the root and a cascade from it
   * read. Walked a level at a time with scoped SELECTs (the tenant guard's analyser is
   * conservative about recursive CTEs); the visited set makes it terminate over any data, and
   * {@link MAX_GRAPH_NODES} bounds it.
   */
  async listActiveEdgesFrom(
    runner: TenantQueryRunner,
    context: TenantContext,
    rootId: string,
  ): Promise<readonly TypedEdgeRow[]> {
    const columns = {
      id: workItemDependencies.id,
      workItemId: workItemDependencies.workItemId,
      dependsOnWorkItemId: workItemDependencies.dependsOnWorkItemId,
      kind: workItemDependencies.kind,
      lag: workItemDependencies.lagWorkingDays,
    };
    const active = and(
      eq(workItemDependencies.organizationId, context.organizationId),
      eq(workItemDependencies.status, 'active'),
    );
    const byId = new Map<string, TypedEdgeRow>();
    const visited = new Set<string>([rootId]);
    let frontier = [rootId];
    while (frontier.length > 0 && visited.size <= MAX_GRAPH_NODES) {
      const rows = await tenantDrizzle(runner)
        .select(columns)
        .from(workItemDependencies)
        .where(and(active, inArray(workItemDependencies.dependsOnWorkItemId, frontier)));
      frontier = [];
      for (const row of rows) {
        byId.set(row.id, toTypedEdge(row));
        if (!visited.has(row.workItemId)) {
          visited.add(row.workItemId);
          frontier.push(row.workItemId);
        }
      }
    }
    const incoming = await tenantDrizzle(runner)
      .select(columns)
      .from(workItemDependencies)
      .where(and(active, inArray(workItemDependencies.workItemId, [...visited])));
    for (const row of incoming) byId.set(row.id, toTypedEdge(row));
    return [...byId.values()];
  }

  /**
   * Add one edge: `workItemId` depends on `dependsOnWorkItemId`. The caller has already proved
   * both rows exist in this tenant, locked their projects and run the cycle check.
   */
  async addDependency(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    dependsOnWorkItemId: string,
    typed: TypedDependencyInput = { kind: 'FS', lag: 0, source: 'ui' },
  ): Promise<WorkItemDependencyRow> {
    if (workItemId === dependsOnWorkItemId) throw new SelfDependencyError();

    const id = uuidv7();
    try {
      await tenantDrizzle(runner)
        .insert(workItemDependencies)
        .values({
          id,
          organizationId: context.organizationId,
          workItemId,
          dependsOnWorkItemId,
          kind: typed.kind,
          lagWorkingDays: typed.lag,
          createdSource: typed.source,
          createdByUserId: context.userId,
          createdAt: sql`current_timestamp(3)`,
        });
    } catch (error) {
      if (isDuplicateKey(error)) throw new DuplicateDependencyError();
      if (isSignalled(error, 'cannot depend on itself')) throw new SelfDependencyError();
      throw error;
    }
    return this.requireDependency(runner, context, id);
  }

  /** One edge of `workItemId`, or null. */
  async findDependency(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    dependencyId: string,
  ): Promise<WorkItemDependencyRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(workItemDependencies)
      .where(
        and(
          eq(workItemDependencies.organizationId, context.organizationId),
          eq(workItemDependencies.id, dependencyId),
          eq(workItemDependencies.workItemId, workItemId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** 53-04. Change an edge's kind and lag in place (0293's trigger keeps its ends fixed). */
  async updateDependency(
    runner: TenantQueryRunner,
    context: TenantContext,
    dependencyId: string,
    typed: { readonly kind: DependencyKind; readonly lag: number },
  ): Promise<WorkItemDependencyRow> {
    await tenantDrizzle(runner)
      .update(workItemDependencies)
      .set({ kind: typed.kind, lagWorkingDays: typed.lag })
      .where(
        and(
          eq(workItemDependencies.organizationId, context.organizationId),
          eq(workItemDependencies.id, dependencyId),
        ),
      );
    return this.requireDependency(runner, context, dependencyId);
  }

  private async requireDependency(
    runner: TenantQueryRunner,
    context: TenantContext,
    dependencyId: string,
  ): Promise<WorkItemDependencyRow> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(workItemDependencies)
      .where(
        and(
          eq(workItemDependencies.organizationId, context.organizationId),
          eq(workItemDependencies.id, dependencyId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) throw new Error(`Dependency ${dependencyId} was not found`);
    return row;
  }

  /** Remove one edge. Idempotent: an edge already gone stays gone. Returns what happened. */
  async removeDependency(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    dependencyId: string,
  ): Promise<WorkItemDependencyRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(workItemDependencies)
      .where(
        and(
          eq(workItemDependencies.organizationId, context.organizationId),
          eq(workItemDependencies.id, dependencyId),
          eq(workItemDependencies.workItemId, workItemId),
        ),
      )
      .limit(1);
    const existing = rows[0];
    if (!existing) return null;

    await tenantDrizzle(runner)
      .delete(workItemDependencies)
      .where(
        and(
          eq(workItemDependencies.organizationId, context.organizationId),
          eq(workItemDependencies.id, dependencyId),
        ),
      );
    return existing;
  }

  /** A row's predecessors, joined to the facts the health signal reads. Oldest edge first. */
  async listPredecessors(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
  ): Promise<readonly PredecessorHealthRow[]> {
    const rows = await tenantDrizzle(runner)
      .select({
        dependencyId: workItemDependencies.id,
        workItemId: workItems.id,
        projectId: workItems.projectId,
        audience: workItems.audience,
        title: workItems.title,
        state: workItems.state,
        dueAt: workItems.dueAt,
        deletedAt: workItems.deletedAt,
      })
      .from(workItemDependencies)
      .innerJoin(
        workItems,
        and(
          eq(workItems.organizationId, workItemDependencies.organizationId),
          eq(workItems.id, workItemDependencies.dependsOnWorkItemId),
        ),
      )
      .where(
        and(
          eq(workItemDependencies.organizationId, context.organizationId),
          eq(workItemDependencies.workItemId, workItemId),
        ),
      )
      .orderBy(asc(workItemDependencies.id));
    return rows;
  }

  /**
   * The predecessors of many items at once, grouped by the depending item — the batched form
   * of {@link listPredecessors} for the project-health roll-up, so a project's walk issues one
   * query rather than one per item (x88 / review-x86 F3). Each group preserves the same
   * oldest-edge-first order {@link listPredecessors} returns; an item with no edges is absent
   * from the map (the caller reads it as an empty list).
   */
  async listPredecessorsByItem(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemIds: readonly string[],
  ): Promise<Map<string, readonly PredecessorHealthRow[]>> {
    const grouped = new Map<string, PredecessorHealthRow[]>();
    if (workItemIds.length === 0) return grouped;
    const rows = await tenantDrizzle(runner)
      .select({
        dependentId: workItemDependencies.workItemId,
        dependencyId: workItemDependencies.id,
        workItemId: workItems.id,
        projectId: workItems.projectId,
        audience: workItems.audience,
        title: workItems.title,
        state: workItems.state,
        dueAt: workItems.dueAt,
        deletedAt: workItems.deletedAt,
      })
      .from(workItemDependencies)
      .innerJoin(
        workItems,
        and(
          eq(workItems.organizationId, workItemDependencies.organizationId),
          eq(workItems.id, workItemDependencies.dependsOnWorkItemId),
        ),
      )
      .where(
        and(
          eq(workItemDependencies.organizationId, context.organizationId),
          inArray(workItemDependencies.workItemId, workItemIds),
        ),
      )
      .orderBy(asc(workItemDependencies.workItemId), asc(workItemDependencies.id));
    for (const { dependentId, ...predecessor } of rows) {
      const list = grouped.get(dependentId);
      if (list) list.push(predecessor);
      else grouped.set(dependentId, [predecessor]);
    }
    return grouped;
  }

  // ── Blockers ───────────────────────────────────────────────────────────────

  /** Raise a blocker. The engine refuses a second active one; see the class doc. */
  async raiseBlocker(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: {
      readonly workItemId: string;
      readonly reason: string;
      readonly ask: string;
      readonly ownerUserId: string | null;
    },
  ): Promise<WorkBlockerRow> {
    const id = uuidv7();
    try {
      await tenantDrizzle(runner)
        .insert(workBlockers)
        .values({
          id,
          organizationId: context.organizationId,
          workItemId: input.workItemId,
          reason: input.reason,
          ask: input.ask,
          ownerUserId: input.ownerUserId,
          createdByUserId: context.userId,
          createdAt: sql`current_timestamp(3)`,
        });
    } catch (error) {
      if (isDuplicateKey(error)) throw new WorkItemAlreadyBlockedError(input.workItemId);
      throw error;
    }
    return this.requireBlocker(runner, context, id);
  }

  /** Resolve the active blocker. Returns it, or null when nothing was open. */
  async resolveActiveBlocker(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    resolution: string,
  ): Promise<WorkBlockerRow | null> {
    const open = await this.findActiveBlocker(runner, context, workItemId);
    if (!open) return null;

    await tenantDrizzle(runner)
      .update(workBlockers)
      .set({
        resolvedAt: sql`current_timestamp(3)`,
        resolution,
        resolvedByUserId: context.userId,
      })
      .where(
        and(eq(workBlockers.organizationId, context.organizationId), eq(workBlockers.id, open.id)),
      );
    return this.requireBlocker(runner, context, open.id);
  }

  async findActiveBlocker(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
  ): Promise<WorkBlockerRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(workBlockers)
      .where(
        and(
          eq(workBlockers.organizationId, context.organizationId),
          eq(workBlockers.workItemId, workItemId),
          isNull(workBlockers.resolvedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * The active blocker of many items at once, keyed by item — the batched form of
   * {@link findActiveBlocker} for the project-health roll-up (x88 / review-x86 F3). One active
   * blocker per item is the engine's invariant (0011), so each item maps to at most one row; an
   * unblocked item is absent from the map (the caller reads it as `null`).
   */
  async findActiveBlockersByItem(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemIds: readonly string[],
  ): Promise<Map<string, WorkBlockerRow>> {
    const byItem = new Map<string, WorkBlockerRow>();
    if (workItemIds.length === 0) return byItem;
    const rows = await tenantDrizzle(runner)
      .select()
      .from(workBlockers)
      .where(
        and(
          eq(workBlockers.organizationId, context.organizationId),
          inArray(workBlockers.workItemId, workItemIds),
          isNull(workBlockers.resolvedAt),
        ),
      );
    for (const row of rows) byItem.set(row.workItemId, row);
    return byItem;
  }

  /** The whole ledger for one item, oldest first — US-B04's history of raised and resolved. */
  async listBlockers(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
  ): Promise<readonly WorkBlockerRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(workBlockers)
      .where(
        and(
          eq(workBlockers.organizationId, context.organizationId),
          eq(workBlockers.workItemId, workItemId),
        ),
      )
      .orderBy(asc(workBlockers.id));
  }

  private async requireBlocker(
    runner: TenantQueryRunner,
    context: TenantContext,
    blockerId: string,
  ): Promise<WorkBlockerRow> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(workBlockers)
      .where(
        and(
          eq(workBlockers.organizationId, context.organizationId),
          eq(workBlockers.id, blockerId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) throw new Error(`Blocker ${blockerId} was not found`);
    return row;
  }

  // ── The one membership read the blocker owner needs ────────────────────────

  /**
   * Whether a user holds an **active internal membership** in this tenant — the check a
   * blocker's `ownerUserId` must pass, because an ask on a person who cannot act in this
   * organization is an ask on nobody. A read of `memberships`, scoped like every other.
   */
  async isActiveInternalMember(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId: string,
  ): Promise<boolean> {
    const rows = await tenantDrizzle(runner)
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.userId, userId),
          eq(memberships.status, 'active'),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }
}
