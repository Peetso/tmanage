import { and, asc, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { milestoneLinks, projectMilestones } from '../../common/database/schema.js';
import type { MilestoneLinkRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The milestone-links repository — PROJ / module 8 (x236), following the `objective_work_links`
 * (0047) pattern exactly.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner`
 *    and the `TenantContext`; there is no overload without a context.
 * 2. **The tenant comes from the context, never the DTO.** {@link CreateMilestoneLinkInput} has no
 *    `organizationId` field, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, executed through the guard (`drizzle.ts`).
 *
 * The runner is a parameter, not a field: the repository holds no connection and no state.
 */

/** Note what is absent: `organizationId`. It is taken from the context. */
export interface CreateMilestoneLinkInput {
  readonly milestoneId: string;
  readonly dependsOnMilestoneId: string;
  /** The person who created the dependency — the service passes `context.userId`. */
  readonly createdBy: string;
}

/** A link joined to the prerequisite milestone it names, for the list projection. */
export interface MilestoneLinkWithTarget {
  readonly link: MilestoneLinkRow;
  readonly dependsOnTitle: string;
  readonly dependsOnStatus: string;
}

/** A directed edge `milestoneId → dependsOnMilestoneId`, for cycle detection. */
export interface MilestoneEdge {
  readonly milestoneId: string;
  readonly dependsOnMilestoneId: string;
}

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;

export function effectivePageSize(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

export class MilestoneLinksRepository {
  /**
   * List one milestone's dependencies, within the acting tenant, joined to each prerequisite
   * milestone so the caller can render a title and status without a second query. Both
   * `organization_id` predicates are present, and the join is on the composite
   * `(organization_id, id)` so it never crosses a tenant. The order is `created_at ASC, id ASC` —
   * oldest dependency first, with the UUIDv7 id as the deterministic tiebreaker.
   */
  async listByMilestone(
    runner: TenantQueryRunner,
    context: TenantContext,
    milestoneId: string,
    limit?: number,
  ): Promise<readonly MilestoneLinkWithTarget[]> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select({
        link: milestoneLinks,
        title: projectMilestones.title,
        status: projectMilestones.status,
      })
      .from(milestoneLinks)
      .innerJoin(
        projectMilestones,
        and(
          eq(projectMilestones.organizationId, milestoneLinks.organizationId),
          eq(projectMilestones.id, milestoneLinks.dependsOnMilestoneId),
        ),
      )
      .where(
        and(
          eq(milestoneLinks.organizationId, context.organizationId),
          eq(milestoneLinks.milestoneId, milestoneId),
        ),
      )
      .orderBy(asc(milestoneLinks.createdAt), asc(milestoneLinks.id))
      .limit(effectivePageSize(limit));

    return rows.map((row) => ({
      link: row.link,
      dependsOnTitle: row.title,
      dependsOnStatus: row.status,
    }));
  }

  /**
   * List every dependency edge whose dependent milestone belongs to one project, within the acting
   * tenant — the adjacency the service walks to reject a cycle before a write. The join binds each
   * edge's `milestone_id` to a `project_milestones` row of the same tenant and filters by that
   * milestone's `project_id`, so the returned edges are exactly the dependency subgraph of one
   * project (every edge this slice creates has both ends in the same project).
   */
  async listEdgesForProject(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<readonly MilestoneEdge[]> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select({
        milestoneId: milestoneLinks.milestoneId,
        dependsOnMilestoneId: milestoneLinks.dependsOnMilestoneId,
      })
      .from(milestoneLinks)
      .innerJoin(
        projectMilestones,
        and(
          eq(projectMilestones.organizationId, milestoneLinks.organizationId),
          eq(projectMilestones.id, milestoneLinks.milestoneId),
        ),
      )
      .where(
        and(
          eq(milestoneLinks.organizationId, context.organizationId),
          eq(projectMilestones.projectId, projectId),
        ),
      );

    return rows.map((row) => ({
      milestoneId: row.milestoneId,
      dependsOnMilestoneId: row.dependsOnMilestoneId,
    }));
  }

  /**
   * Fetch one link by its (milestone, depends-on) pair, within the acting tenant. Returns null when
   * the pair is not linked — the service uses this to make a duplicate link idempotent.
   */
  async findByPair(
    runner: TenantQueryRunner,
    context: TenantContext,
    milestoneId: string,
    dependsOnMilestoneId: string,
  ): Promise<MilestoneLinkRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(milestoneLinks)
      .where(
        and(
          eq(milestoneLinks.organizationId, context.organizationId),
          eq(milestoneLinks.milestoneId, milestoneId),
          eq(milestoneLinks.dependsOnMilestoneId, dependsOnMilestoneId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Fetch one link by id, within the acting tenant. No `findById(id)` without a context: on MySQL
   * that would return another customer's row.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    linkId: string,
  ): Promise<MilestoneLinkRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(milestoneLinks)
      .where(
        and(
          eq(milestoneLinks.organizationId, context.organizationId),
          eq(milestoneLinks.id, linkId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Create a dependency edge. `organization_id` comes from the context, never from `input`. The
   * caller (the service) has already resolved both milestones tenant-scoped and in the same project,
   * rejected a self-link and a cycle, and checked the pair is not already linked; the
   * `uq_milestone_links_pair` unique key is the structural backstop, and the composite foreign keys
   * refuse a milestone from another tenant.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateMilestoneLinkInput,
  ): Promise<MilestoneLinkRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();
    await db.insert(milestoneLinks).values({
      id,
      organizationId: context.organizationId,
      milestoneId: input.milestoneId,
      dependsOnMilestoneId: input.dependsOnMilestoneId,
      createdBy: input.createdBy,
      createdAt: sql`current_timestamp(3)`,
    });

    const created = await this.findById(runner, context, id);
    if (!created) throw new Error(`milestone link ${id} vanished immediately after insert`);
    return created;
  }

  /**
   * Remove a link by id, within the acting tenant. The predicate carries both `organization_id` and
   * `id`, so a cross-tenant id deletes nothing — the service resolves the edge tenant-scoped first.
   */
  async deleteById(
    runner: TenantQueryRunner,
    context: TenantContext,
    linkId: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .delete(milestoneLinks)
      .where(
        and(
          eq(milestoneLinks.organizationId, context.organizationId),
          eq(milestoneLinks.id, linkId),
        ),
      );
  }
}
