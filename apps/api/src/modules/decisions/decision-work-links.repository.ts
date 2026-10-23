import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { decisionWorkLinks, memberships, users, workItems } from '../../common/database/schema.js';
import type { DecisionWorkLinkRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The decision→work-links repository — DEC / module 12 (x149), following the
 * `objective_work_links` / `work_item_dependencies` pattern.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner`
 *    and the `TenantContext`; there is no overload without a context.
 * 2. **The tenant comes from the context, never the DTO.** {@link CreateDecisionWorkLinkInput} has
 *    no `organizationId` field, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, executed through the guard (`drizzle.ts`).
 *
 * The runner is a parameter, not a field: the repository holds no connection and no state.
 */

export class DecisionWorkLinkNotFoundError extends Error {
  constructor(readonly linkId: string) {
    // No organization id in the message: a not-found must not let a probe for another tenant's link
    // tell "does not exist" from "exists elsewhere" (spec §4).
    super(`Decision work link ${linkId} was not found`);
    this.name = 'DecisionWorkLinkNotFoundError';
  }
}

/** Raised when the (decision, work item) pair is already linked — the service maps it to 409. */
export class DuplicateDecisionWorkLinkError extends Error {
  constructor(
    readonly decisionId: string,
    readonly workItemId: string,
  ) {
    super('This work item is already linked to the decision');
    this.name = 'DuplicateDecisionWorkLinkError';
  }
}

/** Note what is absent: `organizationId`. It is taken from the context. */
export interface CreateDecisionWorkLinkInput {
  readonly decisionId: string;
  readonly workItemId: string;
  /** The person who created the link — the service passes `context.userId`. */
  readonly createdBy: string;
}

/** A link joined to the work item it names, for the list projection. */
export interface DecisionWorkLinkWithItem {
  readonly link: DecisionWorkLinkRow;
  readonly workItemTitle: string;
  readonly workItemState: string;
  /** A15. The work item's owner, by display name in this tenant; `null` when unowned. */
  readonly workItemOwnerName: string | null;
  /** A15. The work item's due instant; `null` when it has none. */
  readonly workItemDueAt: Date | null;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

export function effectivePageSize(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

export class DecisionWorkLinksRepository {
  /**
   * List one decision's links, within the acting tenant, joined to each linked work item so the
   * caller can render a title and state without a second query. Both `organization_id` predicates are
   * present, and the join is on the composite `(organization_id, work_item_id)` so it never crosses a
   * tenant. The order is `created_at ASC, id ASC` — oldest link first, with the UUIDv7 id as the
   * deterministic tiebreaker.
   */
  async listByDecision(
    runner: TenantQueryRunner,
    context: TenantContext,
    decisionId: string,
    limit?: number,
  ): Promise<readonly DecisionWorkLinkWithItem[]> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select({
        link: decisionWorkLinks,
        title: workItems.title,
        state: workItems.state,
        dueAt: workItems.dueAt,
        ownerName: users.displayName,
      })
      .from(decisionWorkLinks)
      .innerJoin(
        workItems,
        and(
          eq(workItems.organizationId, decisionWorkLinks.organizationId),
          eq(workItems.id, decisionWorkLinks.workItemId),
        ),
      )
      // A15. The owner's name through this tenant's membership, so another tenant's user never shows.
      .leftJoin(
        memberships,
        and(
          eq(memberships.organizationId, workItems.organizationId),
          eq(memberships.userId, workItems.ownerUserId),
        ),
      )
      .leftJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(decisionWorkLinks.organizationId, context.organizationId),
          eq(decisionWorkLinks.decisionId, decisionId),
        ),
      )
      .orderBy(asc(decisionWorkLinks.createdAt), asc(decisionWorkLinks.id))
      .limit(effectivePageSize(limit));

    return rows.map((row) => ({
      link: row.link,
      workItemTitle: row.title,
      workItemState: row.state,
      workItemOwnerName: row.ownerName ?? null,
      workItemDueAt: row.dueAt ?? null,
    }));
  }

  /** A15. A member's display name in this tenant (a new link's owner), or `null`. */
  async findMemberName(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId: string,
  ): Promise<string | null> {
    const rows = await tenantDrizzle(runner)
      .select({ displayName: users.displayName })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(eq(memberships.organizationId, context.organizationId), eq(memberships.userId, userId)),
      )
      .limit(1);
    return rows[0]?.displayName ?? null;
  }

  /**
   * Fetch one link by id, within the acting tenant. No `findById(id)` without a context: on MySQL
   * that would return another customer's row.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    linkId: string,
  ): Promise<DecisionWorkLinkRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(decisionWorkLinks)
      .where(
        and(
          eq(decisionWorkLinks.organizationId, context.organizationId),
          eq(decisionWorkLinks.id, linkId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Create a link. `organization_id` comes from the context, never from `input`. The pair is checked
   * for an existing edge first (within the caller's transaction) so a duplicate is a
   * {@link DuplicateDecisionWorkLinkError} the service maps to 409; the `uq_decision_work_links_pair`
   * unique key is the backstop for a race the pre-check cannot see. The composite foreign keys refuse
   * a decision or work item from another tenant, so the service's tenant/project resolution is the
   * primary check and the keys the structural one.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateDecisionWorkLinkInput,
  ): Promise<DecisionWorkLinkRow> {
    const db = tenantDrizzle(runner);

    const existing = await db
      .select({ id: decisionWorkLinks.id })
      .from(decisionWorkLinks)
      .where(
        and(
          eq(decisionWorkLinks.organizationId, context.organizationId),
          eq(decisionWorkLinks.decisionId, input.decisionId),
          eq(decisionWorkLinks.workItemId, input.workItemId),
        ),
      )
      .limit(1);
    if (existing[0]) {
      throw new DuplicateDecisionWorkLinkError(input.decisionId, input.workItemId);
    }

    const id = uuidv7();
    await db.insert(decisionWorkLinks).values({
      id,
      organizationId: context.organizationId,
      decisionId: input.decisionId,
      workItemId: input.workItemId,
      createdBy: input.createdBy,
      createdAt: sql`current_timestamp(3)`,
    });

    const created = await this.findById(runner, context, id);
    if (!created) throw new DecisionWorkLinkNotFoundError(id);
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
      .delete(decisionWorkLinks)
      .where(
        and(
          eq(decisionWorkLinks.organizationId, context.organizationId),
          eq(decisionWorkLinks.id, linkId),
        ),
      );
  }
}
