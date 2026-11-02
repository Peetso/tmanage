import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  projectBaselineItems,
  projectBaselines,
  projectMilestones,
  workItems,
} from '../../common/database/schema.js';
import type {
  ProjectBaselineItemRow,
  ProjectBaselineMilestoneSnapshot,
  ProjectBaselineRow,
  ProjectMilestoneRow,
  WorkItemRow,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The project milestone-plan baseline repository — PROJ / module 8 (x295), following the
 * `project-objectives` / `risk-register` pattern.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally: every method's first
 * two parameters are the `TenantQueryRunner` and the `TenantContext` (no unscoped overload), the
 * tenant comes from the context and never the DTO ({@link CreateProjectBaselineInput} has no
 * `organizationId`), and the tenant predicate is on every statement.
 *
 * A baseline is **append-only**: INSERT (freeze), SELECT (list/read) and DELETE (discard). There is no
 * `update` here and no UPDATE grant — a baseline is an immutable point-in-time snapshot, and variance
 * is recomputed at read time from the live milestones against the frozen JSON.
 */

export class ProjectBaselineNotFoundError extends Error {
  constructor(readonly baselineId: string) {
    // No organization id in the message: a not-found must not let a probe for another tenant's
    // baseline tell "does not exist" from "exists elsewhere" (spec §4).
    super(`Project baseline ${baselineId} was not found`);
    this.name = 'ProjectBaselineNotFoundError';
  }
}

/** Note the absent `organizationId`: it is taken from the context, so no body can populate it. */
export interface CreateProjectBaselineInput {
  readonly projectId: string;
  readonly label: string;
  /** The frozen plan, captured from the live milestones by the service at snapshot time. */
  readonly snapshot: readonly ProjectBaselineMilestoneSnapshot[];
  /** The person who froze the baseline — the service passes `context.userId`. */
  readonly createdBy: string;
  /** 53-05: 'milestones' | 'full' (checked by the controller). */
  readonly kind?: BaselineKind;
  readonly note?: string | null;
}

export const BASELINE_KINDS = ['milestones', 'full'] as const;
export type BaselineKind = (typeof BASELINE_KINDS)[number];

/** 53-05: one work item frozen into a 'full' baseline (civil dates in the org calendar's zone). */
export interface NewBaselineItem {
  readonly workItemId: string;
  readonly startAt: string | null;
  readonly dueAt: string | null;
  readonly durationWorkingDays: number | null;
  readonly itemVersion: number | null;
}

/** The live columns a snapshot and a variance read need — never the description. */
export type LiveBaselineItem = Pick<
  WorkItemRow,
  | 'id'
  | 'organizationId'
  | 'projectId'
  | 'title'
  | 'audience'
  | 'state'
  | 'startAt'
  | 'dueAt'
  | 'version'
>;

/** Rows per multi-row INSERT when freezing items. */
const ITEM_INSERT_CHUNK = 500;

export interface ListProjectBaselinesOptions {
  /** Required: this lists one project's baselines, never a whole tenant's. */
  readonly projectId: string;
  readonly limit?: number;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

export function effectivePageSize(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

export class ProjectBaselineRepository {
  /**
   * Read one project's live milestones, within the acting tenant, ordered by target date.
   *
   * Read-only: the baseline slice never writes a milestone. Used both to freeze a baseline at create
   * time and to recompute variance at read time. Both `organization_id` and `project_id` predicates
   * are present; a null `due_on` sorts last, and `id` (UUIDv7) is the deterministic tiebreaker.
   */
  async listMilestones(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<readonly ProjectMilestoneRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select()
      .from(projectMilestones)
      .where(
        and(
          eq(projectMilestones.organizationId, context.organizationId),
          eq(projectMilestones.projectId, projectId),
        ),
      )
      .orderBy(
        sql`${projectMilestones.dueOn} is null`,
        asc(projectMilestones.dueOn),
        asc(projectMilestones.id),
      );
  }

  /**
   * List one project's baselines, within the acting tenant, newest first.
   *
   * Both `organization_id` and `project_id` predicates are present. The order is
   * `created_at DESC, id DESC`: the most recent baseline leads, and `id` (UUIDv7) is the
   * deterministic tiebreaker. The `(organization_id, project_id, created_at)` index (0162) serves it.
   */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: ListProjectBaselinesOptions,
  ): Promise<readonly ProjectBaselineRow[]> {
    const limit = effectivePageSize(options.limit);
    const db = tenantDrizzle(runner);
    return db
      .select()
      .from(projectBaselines)
      .where(
        and(
          eq(projectBaselines.organizationId, context.organizationId),
          eq(projectBaselines.projectId, options.projectId),
        ),
      )
      .orderBy(desc(projectBaselines.createdAt), desc(projectBaselines.id))
      .limit(limit);
  }

  /**
   * Fetch one baseline by id, within the acting tenant.
   *
   * No `findById(id)` without a context: on MySQL that would return another customer's row.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    baselineId: string,
  ): Promise<ProjectBaselineRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(projectBaselines)
      .where(
        and(
          eq(projectBaselines.organizationId, context.organizationId),
          eq(projectBaselines.id, baselineId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async requireById(
    runner: TenantQueryRunner,
    context: TenantContext,
    baselineId: string,
  ): Promise<ProjectBaselineRow> {
    const found = await this.findById(runner, context, baselineId);
    if (!found) throw new ProjectBaselineNotFoundError(baselineId);
    return found;
  }

  /**
   * Freeze a baseline.
   *
   * The id is generated here (UUIDv7) so a command knows it before the insert commits.
   * `organization_id` comes from the context, never from `input`. The project is not checked to
   * belong to the tenant here: the composite foreign key `fk_project_baselines_project_tenant`
   * includes `organization_id`, so the database refuses a project from another tenant. (The service
   * resolves the project first, to map an unknown id to 404 rather than a foreign-key 500.)
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateProjectBaselineInput,
  ): Promise<ProjectBaselineRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    await db.insert(projectBaselines).values({
      id,
      organizationId: context.organizationId,
      projectId: input.projectId,
      label: input.label,
      snapshot: input.snapshot,
      kind: input.kind ?? 'milestones',
      note: input.note ?? null,
      createdBy: input.createdBy,
      createdAt: sql`current_timestamp(3)`,
    });

    // Read back rather than reconstruct: the row now carries a server-generated `created_at`.
    return this.requireById(runner, context, id);
  }

  /**
   * Discard one baseline, within the acting tenant.
   *
   * The predicate carries both `organization_id` and `id`, so a cross-tenant id deletes nothing. The
   * caller has already resolved the baseline tenant-scoped, so this removes a row it has seen.
   */
  async delete(
    runner: TenantQueryRunner,
    context: TenantContext,
    baselineId: string,
  ): Promise<void> {
    const db = tenantDrizzle(runner);
    await db
      .delete(projectBaselines)
      .where(
        and(
          eq(projectBaselines.organizationId, context.organizationId),
          eq(projectBaselines.id, baselineId),
        ),
      );
  }

  // ---- 53-05 (0298) ----

  /** How many baselines a project holds (the 50-per-project cap). */
  async countForProject(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<number> {
    const rows = await tenantDrizzle(runner)
      .select({ n: count() })
      .from(projectBaselines)
      .where(
        and(
          eq(projectBaselines.organizationId, context.organizationId),
          eq(projectBaselines.projectId, projectId),
        ),
      );
    return Number(rows[0]?.n ?? 0);
  }

  /** The project's live (not deleted) work items, id order — the snapshot and variance source. */
  async listLiveItems(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    limit: number,
  ): Promise<readonly LiveBaselineItem[]> {
    return tenantDrizzle(runner)
      .select({
        id: workItems.id,
        organizationId: workItems.organizationId,
        projectId: workItems.projectId,
        title: workItems.title,
        audience: workItems.audience,
        state: workItems.state,
        startAt: workItems.startAt,
        dueAt: workItems.dueAt,
        version: workItems.version,
      })
      .from(workItems)
      .where(
        and(
          eq(workItems.organizationId, context.organizationId),
          eq(workItems.projectId, projectId),
          isNull(workItems.deletedAt),
        ),
      )
      .orderBy(asc(workItems.id))
      .limit(limit);
  }

  /** Freeze items into a baseline, in multi-row chunks, inside the caller's transaction. */
  async insertItems(
    runner: TenantQueryRunner,
    context: TenantContext,
    baselineId: string,
    items: readonly NewBaselineItem[],
  ): Promise<void> {
    const db = tenantDrizzle(runner);
    for (let i = 0; i < items.length; i += ITEM_INSERT_CHUNK) {
      await db.insert(projectBaselineItems).values(
        items.slice(i, i + ITEM_INSERT_CHUNK).map((item) => ({
          id: uuidv7(),
          organizationId: context.organizationId,
          baselineId,
          workItemId: item.workItemId,
          startAt: item.startAt,
          dueAt: item.dueAt,
          durationWorkingDays: item.durationWorkingDays,
          itemVersion: item.itemVersion,
          milestoneId: null,
          createdAt: sql`current_timestamp(3)`,
        })),
      );
    }
  }

  /** One baseline's frozen items, by work item id. */
  async listItems(
    runner: TenantQueryRunner,
    context: TenantContext,
    baselineId: string,
  ): Promise<readonly ProjectBaselineItemRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(projectBaselineItems)
      .where(
        and(
          eq(projectBaselineItems.organizationId, context.organizationId),
          eq(projectBaselineItems.baselineId, baselineId),
        ),
      )
      .orderBy(asc(projectBaselineItems.workItemId));
  }

  /** Frozen item counts for the listed baselines. */
  async itemCounts(
    runner: TenantQueryRunner,
    context: TenantContext,
    baselineIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>> {
    if (baselineIds.length === 0) return new Map();
    const rows = await tenantDrizzle(runner)
      .select({ baselineId: projectBaselineItems.baselineId, n: count() })
      .from(projectBaselineItems)
      .where(
        and(
          eq(projectBaselineItems.organizationId, context.organizationId),
          inArray(projectBaselineItems.baselineId, [...baselineIds]),
        ),
      )
      .groupBy(projectBaselineItems.baselineId);
    return new Map(rows.map((row) => [row.baselineId, Number(row.n)]));
  }

  /** The project's current baseline, or null. */
  async findCurrent(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<ProjectBaselineRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(projectBaselines)
      .where(
        and(
          eq(projectBaselines.organizationId, context.organizationId),
          eq(projectBaselines.projectId, projectId),
          eq(projectBaselines.isCurrent, true),
        ),
      )
      .orderBy(desc(projectBaselines.createdAt), desc(projectBaselines.id))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Make `baselineId` the project's only current baseline: one UPDATE over the project's rows, so
   * two concurrent activations serialise on the row locks and leave exactly one current. Only
   * `is_current` changes — the 0298 trigger refuses any other column.
   */
  async setCurrent(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    baselineId: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(projectBaselines)
      .set({ isCurrent: sql`case when ${projectBaselines.id} = ${baselineId} then 1 else 0 end` })
      .where(
        and(
          eq(projectBaselines.organizationId, context.organizationId),
          eq(projectBaselines.projectId, projectId),
        ),
      );
  }
}
