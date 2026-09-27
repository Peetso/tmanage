import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { WORK_ITEM_STATES } from '@tmanage/domain';
import type { WorkItemState } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  memberships,
  projectMemberships,
  projects,
  users,
  workItems,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * x169's read seam — one member's profile (module 14, audit #4 "People Missing — profile view").
 *
 * The per-member counterpart to x168's directory: given a membership id, it answers three plain
 * questions from data other modules already own — what role the person holds in the org, which
 * projects they belong to, and how much open work they own. It is the org-level people module's
 * detail read: read-only, no table, no column, no migration.
 *
 * ## Resolve-before-authorize, and tenant-scoped in SQL
 *
 * The membership is resolved by `(organization_id, id)` — the FAST-PROTOCOL Known-trap for this
 * slice. A membership id that belongs to another tenant, or none at all, simply is not found in this
 * tenant, so the controller answers a cross-tenant or unknown id with a 404 that is indistinguishable
 * from the id never existing — an existence probe learns nothing, and the resolve runs before the
 * belt-and-braces `authorize()` the controller applies.
 *
 * Every read here filters on `organization_id = context.organizationId`, so a cross-tenant row is
 * never returned in production. The reads carry **no policy** — the `work.read` route gate and the
 * belt-and-braces relation check live in the controller, exactly as the sibling reads keep
 * `authorize()` out of the repository.
 *
 * ## Non-sensitive projection only
 *
 * The member's `display_name`, org `role` and membership `status` are projected — the same
 * non-sensitive field set the directory exposes. No email, locale or timezone is read here, so a
 * sensitive field cannot leak through the profile.
 */

/**
 * Open work is work that still needs someone: every state except the two landed ones, `done` and
 * `archived`. Kept as an `IN` filter (not a `NOT IN`) so the owner-state index is used, and derived
 * from the domain's state list so a new state is open by default — the same definition My Day uses.
 */
const OPEN_WORK_STATES: readonly WorkItemState[] = WORK_ITEM_STATES.filter(
  (state) => state !== 'done' && state !== 'archived',
);

/** The resolved membership — the org it belongs to, the user it names, its role and status. No `View` suffix: not a wire projection. */
export interface PersonProfileMemberRow {
  readonly organizationId: string;
  readonly membershipId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly role: string;
  readonly status: string;
}

/** One project the member belongs to — id, name, the project's status, and the member's project role. */
export interface PersonProfileProjectRow {
  readonly projectId: string;
  readonly name: string;
  readonly status: string;
  readonly role: string;
}

export class PersonProfileRepository {
  /**
   * Resolve one membership by id within this tenant, joined to the user for the display name.
   * Tenant-scoped by `organization_id` so a cross-tenant id is not found (the Known-trap); returns
   * `null` when there is no such membership in this tenant, which the controller turns into a 404.
   */
  async findMember(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<PersonProfileMemberRow | null> {
    const rows = await tenantDrizzle(runner)
      .select({
        organizationId: memberships.organizationId,
        membershipId: memberships.id,
        userId: memberships.userId,
        displayName: users.displayName,
        role: memberships.role,
        status: memberships.status,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.id, membershipId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * The projects the member belongs to — tenant-scoped, joined to `projects` for the name and
   * status, ordered by name for a stable read. One row per project membership; a member's project
   * count is bounded, so this read is unpaged.
   */
  async listProjects(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId: string,
  ): Promise<readonly PersonProfileProjectRow[]> {
    return tenantDrizzle(runner)
      .select({
        projectId: projects.id,
        name: projects.name,
        status: projects.status,
        role: projectMemberships.role,
      })
      .from(projectMemberships)
      .innerJoin(projects, eq(projects.id, projectMemberships.projectId))
      .where(
        and(
          eq(projectMemberships.organizationId, context.organizationId),
          eq(projectMemberships.userId, userId),
        ),
      )
      .orderBy(asc(projects.name), asc(projects.id));
  }

  /**
   * How many open work items the member owns in this tenant — soft-deleted rows excluded, counted in
   * SQL so the figure never turns into an unbounded row fetch. "Open" reuses the My Day definition
   * (every state but `done`/`archived`); the count never widens the owner's own work-visibility.
   */
  async countOpenWork(
    runner: TenantQueryRunner,
    context: TenantContext,
    ownerUserId: string,
  ): Promise<number> {
    const rows = await tenantDrizzle(runner)
      .select({ open: sql<number>`count(*)` })
      .from(workItems)
      .where(
        and(
          eq(workItems.organizationId, context.organizationId),
          eq(workItems.ownerUserId, ownerUserId),
          inArray(workItems.state, [...OPEN_WORK_STATES]),
          isNull(workItems.deletedAt),
        ),
      );
    return Number(rows[0]?.open ?? 0);
  }
}
