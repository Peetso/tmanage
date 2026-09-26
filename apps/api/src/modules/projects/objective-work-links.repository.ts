import { and, asc, eq } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { objectiveWorkLinks, workItems } from '../../common/database/schema.js';
import type { ObjectiveWorkLinkRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The objective→work-links repository — PROJ / module 8 (x138), following the
 * `work_item_dependencies` / `decisions` pattern.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner`
 *    and the `TenantContext`; there is no overload without a context.
 * 2. **The tenant comes from the context, never the DTO.** {@link CreateObjectiveWorkLinkInput} has
 *    no `organizationId` field, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, executed through the guard (`drizzle.ts`).
 *
 * The runner is a parameter, not a field: the repository holds no connection and no state.
 */

export class ObjectiveWorkLinkNotFoundError extends Error {
  constructor(readonly linkId: string) {
    // No organization id in the message: a not-found must not let a probe for another tenant's link
    // tell "does not exist" from "exists elsewhere" (spec §4).
    super(`Objective work link ${linkId} was not found`);
    this.name = 'ObjectiveWorkLinkNotFoundError';
  }
}

/** Raised when the (objective, work item) pair is already linked — the service maps it to 409. */
export class DuplicateObjectiveWorkLinkError extends Error {
  constructor(
    readonly objectiveId: string,
    readonly workItemId: string,
  ) {
    super('This work item is already linked to the objective');
    this.name = 'DuplicateObjectiveWorkLinkError';
  }
}

/** Note what is absent: `organizationId`. It is taken from the context. */
export interface CreateObjectiveWorkLinkInput {
  readonly objectiveId: string;
  readonly workItemId: string;
  /** The person who created the link — the service passes `context.userId`. */
  readonly createdBy: string;
}

/** A link joined to the work item it names, for the list projection. */
export interface ObjectiveWorkLinkWithItem {
  readonly link: ObjectiveWorkLinkRow;
  readonly workItemTitle: string;
  readonly workItemState: string;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

export function effectivePageSize(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

export class ObjectiveWorkLinksRepository {
  /**
   * List one objective's links, within the acting tenant, joined to each linked work item so the
   * caller can render a title and state without a second query. Both `organization_id` predicates are
   * present, and the join is on the composite `(organization_id, work_item_id)` so it never crosses a
   * tenant. The order is `created_at ASC, id ASC` — oldest link first, with the UUIDv7 id as the
   * deterministic tiebreaker.
   */
  async listByObjective(
    runner: TenantQueryRunner,
    context: TenantContext,
    objectiveId: string,
    limit?: number,
  ): Promise<readonly ObjectiveWorkLinkWithItem[]> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select({ link: objectiveWorkLinks, title: workItems.title, state: workItems.state })
      .from(objectiveWorkLinks)
      .innerJoin(
        workItems,
        and(
          eq(workItems.organizationId, objectiveWorkLinks.organizationId),
          eq(workItems.id, objectiveWorkLinks.workItemId),
        ),
      )
      .where(
        and(
          eq(objectiveWorkLinks.organizationId, context.organizationId),
          eq(objectiveWorkLinks.objectiveId, objectiveId),
        ),
      )
      .orderBy(asc(objectiveWorkLinks.createdAt), asc(objectiveWorkLinks.id))
      .limit(effectivePageSize(limit));

    return rows.map((row) => ({
      link: row.link,
      workItemTitle: row.title,
      workItemState: row.state,
    }));
  }

  /**
   * Fetch one link by id, within the acting tenant. No `findById(id)` without a context: on MySQL
   * that would return another customer's row.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    linkId: string,
  ): Promise<ObjectiveWorkLinkRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(objectiveWorkLinks)
      .where(
        and(
          eq(objectiveWorkLinks.organizationId, context.organizationId),
          eq(objectiveWorkLinks.id, linkId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Create a link. `organization_id` comes from the context, never from `input`. The pair is checked
   * for an existing edge first (within the caller's transaction) so a duplicate is a
   * {@link DuplicateObjectiveWorkLinkError} the service maps to 409; the `uq_objective_work_links_pair`
   * unique key is the backstop for a race the pre-check cannot see. The composite foreign keys refuse
   * an objective or work item from another tenant, so the service's tenant/project resolution is the
   * primary check and the keys the structural one.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateObjectiveWorkLinkInput,
  ): Promise<ObjectiveWorkLinkRow> {
    const db = tenantDrizzle(runner);

    const existing = await db
      .select({ id: objectiveWorkLinks.id })
      .from(objectiveWorkLinks)
      .where(
        and(
          eq(objectiveWorkLinks.organizationId, context.organizationId),
          eq(objectiveWorkLinks.objectiveId, input.objectiveId),
          eq(objectiveWorkLinks.workItemId, input.workItemId),
        ),
      )
      .limit(1);
    if (existing[0]) {
      throw new DuplicateObjectiveWorkLinkError(input.objectiveId, input.workItemId);
    }

    const id = uuidv7();
    await db.insert(objectiveWorkLinks).values({
      id,
      organizationId: context.organizationId,
      objectiveId: input.objectiveId,
      workItemId: input.workItemId,
      createdBy: input.createdBy,
    });

    const created = await this.findById(runner, context, id);
    if (!created) throw new ObjectiveWorkLinkNotFoundError(id);
    return created;
  }

  /**
   * Remove a link by id, within the acting tenant. The predicate carries both `organization_id` and
   * `id`, so a cross-tenant id deletes nothing — the service resolves the id tenant-scoped first and
   * returns a 404 for an unknown or cross-tenant link, so this method only ever runs for a link the
   * caller may see.
   */
  async deleteById(
    runner: TenantQueryRunner,
    context: TenantContext,
    linkId: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .delete(objectiveWorkLinks)
      .where(
        and(
          eq(objectiveWorkLinks.organizationId, context.organizationId),
          eq(objectiveWorkLinks.id, linkId),
        ),
      );
  }
}
