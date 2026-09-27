import { and, asc, eq, gt, inArray, like, sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { memberships, projectMemberships, users } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The People & capacity directory — module 14, audit #4.
 *
 * ## Why a second read over the same rows
 *
 * `MembershipsRepository.listWithNames` (D16) already names each active member for a picker.
 * This read answers a different question — *who is in this organization and how loaded are
 * they* — and adds the one field a picker never needed: how many projects the person is on.
 * That field is a `LEFT JOIN` over `project_memberships`, so it is a separate method rather
 * than another column on the picker's list, which several internal callers read as-is and
 * would then carry an aggregate they never use.
 *
 * ## Tenant scope is the same, and the join does not widen it
 *
 * `memberships` is anchored to the active organization by a bound `organization_id = ?`
 * exactly as the picker is. `users` carries no `organization_id` and is global identity, so it
 * needs no anchor. `project_memberships` is a tenant table, and its `LEFT JOIN` predicate ties
 * `project_memberships.organization_id` to `memberships.organization_id` — a join equality the
 * tenant guard follows to place it in the same anchored group. A person's project count is
 * therefore only ever counted from this tenant's own rows: an adjacent organization's
 * `project_memberships` row is unreachable because its `organization_id` never equals this
 * context's, so it falls outside the join and the count.
 *
 * ## The projection is deliberately narrow
 *
 * Name, role, status and a count — no email, no secret, nothing beyond what the picker already
 * exposes plus a number. A member directory exists so the organization can see who is on it and
 * plan capacity by name, not so a roster becomes worth exfiltrating.
 */

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/** One directory row: the member, the name they are known by, and how many projects they are on. */
export interface PersonDirectoryEntry {
  readonly membershipId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly role: string;
  readonly status: string;
  readonly projectCount: number;
}

export interface PersonDirectoryOptions {
  readonly after?: string;
  readonly limit?: number;
  /**
   * A fragment of the name to look for, matched as a contains. Blank or whitespace-only is the
   * same as absent — an empty search box asks for everybody. It narrows this tenant's own query
   * and cannot widen who is reachable.
   */
  readonly q?: string;
}

/**
 * Make a person's typed text safe to put inside a `LIKE` pattern.
 *
 * `%` and `_` are `LIKE`'s wildcards and `\` its escape character. Not injection defence — the
 * pattern is a bound parameter and the guard would reject it otherwise — but so the pattern
 * means what was typed: a name containing `_` finds itself rather than every name of the same
 * length, and a typed `%` matches nothing rather than the whole roster.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export class PeopleDirectoryRepository {
  /**
   * The organization's active members, by name, each with a project count.
   *
   * Active only, and not a query parameter: an invited person authorises nothing and a
   * suspended one holds no capacity, so the capacity view answers the question it is actually
   * asked. Keyset-paged on `memberships.id`, the same cursor the picker uses.
   */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: PersonDirectoryOptions = {},
  ): Promise<readonly PersonDirectoryEntry[]> {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const search = options.q?.trim() ?? '';

    const predicates = [
      eq(memberships.organizationId, context.organizationId),
      inArray(memberships.status, ['active']),
    ];
    if (options.after) predicates.push(gt(memberships.id, options.after));
    if (search !== '') {
      predicates.push(like(users.displayName, `%${escapeLikePattern(search)}%`));
    }

    const rows = await tenantDrizzle(runner)
      .select({
        membershipId: memberships.id,
        userId: memberships.userId,
        displayName: users.displayName,
        role: memberships.role,
        status: memberships.status,
        projectCount: sql<number>`count(distinct ${projectMemberships.id})`,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .leftJoin(
        projectMemberships,
        and(
          eq(projectMemberships.organizationId, memberships.organizationId),
          eq(projectMemberships.userId, memberships.userId),
        ),
      )
      .where(and(...predicates))
      .groupBy(
        memberships.id,
        memberships.userId,
        users.displayName,
        memberships.role,
        memberships.status,
      )
      .orderBy(asc(memberships.id))
      .limit(limit);

    return rows.map((row) => ({
      membershipId: row.membershipId,
      userId: row.userId,
      displayName: row.displayName,
      role: row.role,
      status: row.status,
      projectCount: Number(row.projectCount ?? 0),
    }));
  }
}
