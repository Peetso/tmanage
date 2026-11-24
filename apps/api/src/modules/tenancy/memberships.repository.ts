import { and, asc, eq, gt, inArray, like, ne, sql } from 'drizzle-orm';
import { PLATFORM_SUPPORT_ROLE, uuidv7 } from '@tmanage/domain';
import type { InternalRole } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  type MEMBERSHIP_STATUS,
  memberships,
  projectMemberships,
  users,
} from '../../common/database/schema.js';
import type { MembershipRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { defaultOrgWideScope } from './principal.repository.js';

/**
 * The membership aggregate — TEN-001, and the row every `TenantContext` is built from.
 *
 * Follows `ProjectsRepository`: `TenantContext` first, no `organizationId` on any input type,
 * keyset pagination, optimistic concurrency, not-found rather than conflict for a caller in
 * the wrong tenant.
 *
 * Two things differ from the projects repository, and both come from the schema rather than
 * from taste:
 *
 * 1. **Concurrency is a `version` column, not `updated_at`.** `memberships` has one. It is
 *    the better token — two role changes in the same millisecond are distinguishable, where
 *    `DATETIME(3)` equality is not — and the repository uses whichever the table actually
 *    provides rather than a single house style applied over the top of both.
 * 2. **Status moves through a checked transition, not a free assignment.** The states are
 *    an authorization fact: an `active` row is what lets someone into the tenant at all.
 *
 * ## Why `offboarded` is terminal here
 *
 * `packages/domain`'s offboarding machine records `OFFBOARDING_NEVER_AUTO_RESTORES_ACCESS`,
 * and this is the storage-layer half of it. Re-admitting someone is a new membership — a
 * deliberate act, freshly audited, with a new id — not the reversal of a status flag. A
 * reversible terminal state is how a revoked contractor is restored by a bulk edit nobody
 * reviews.
 */

export type MembershipStatus = (typeof MEMBERSHIP_STATUS)[number];

/**
 * Which status changes are permitted. Absent pairs are refused, and `offboarded` has no
 * outbound entry at all.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<MembershipStatus, readonly MembershipStatus[]>> =
  Object.freeze({
    invited: ['active', 'offboarded'],
    active: ['suspended', 'offboarded'],
    suspended: ['active', 'offboarded'],
    offboarded: [],
  });

export class MembershipNotFoundError extends Error {
  constructor(readonly membershipId: string) {
    super(`Membership ${membershipId} was not found`);
    this.name = 'MembershipNotFoundError';
  }
}

export class MembershipVersionConflictError extends Error {
  constructor(
    readonly membershipId: string,
    readonly expectedVersion: number,
  ) {
    super(
      `Membership ${membershipId} was modified concurrently (expected version ${expectedVersion})`,
    );
    this.name = 'MembershipVersionConflictError';
  }
}

export class MembershipTransitionError extends Error {
  constructor(
    readonly from: MembershipStatus,
    readonly to: MembershipStatus,
  ) {
    super(`A membership cannot move from ${from} to ${to}`);
    this.name = 'MembershipTransitionError';
  }
}

export interface InviteMembershipInput {
  readonly userId: string;
  readonly role: InternalRole;
  /**
   * Overrides {@link defaultOrgWideScope}. Present so that granting organization-wide reach
   * is a recorded decision rather than a consequence of a role name — the column is stored
   * rather than derived precisely so a later policy change cannot widen it retroactively.
   */
  readonly hasOrgWideScope?: boolean;
  /**
   * A Workspace Admin's one-workspace scope (0023), or null/absent for none. Like
   * `hasOrgWideScope`, it is an explicit recorded decision — a workspace scope is never a
   * consequence of a role name, so an org-wide leak cannot arrive through a default.
   */
  readonly workspaceScopeId?: string | null;
}

export interface ListMembershipsOptions {
  readonly after?: string;
  readonly limit?: number;
  /** Defaults to active memberships only; the invited and suspended are opt-in. */
  readonly statuses?: readonly MembershipStatus[];
}

/**
 * `listWithNames`' options: the membership list's, plus the directory's own search term.
 *
 * Separate from `ListMembershipsOptions` because only the directory has a name to search: the
 * plain membership list projects no `display_name` and joins no `users`, so a `q` on it would
 * be a field nothing could honour.
 */
export interface MemberDirectoryOptions extends ListMembershipsOptions {
  /**
   * A fragment of the name to look for, matched as a contains.
   *
   * This is what makes an organization larger than one page usable at all: without it a picker
   * reads the first 50 rows and the fifty-first member can never be assigned anything, because
   * nothing on the client can ask for somebody it has not already been sent. The search belongs
   * on the server for the same reason — a client that paged the whole roster into memory to
   * filter it would be downloading the staff list to answer one keystroke.
   *
   * Blank or whitespace-only is the same as absent: an empty search box asks for everybody.
   */
  readonly q?: string;
  /**
   * QA-FIX-P S2 (ADR-0014): only these people. A guest's roster is the people who share a
   * project with them, from {@link coMemberUserIds}. Absent means the whole organization.
   */
  readonly onlyUserIds?: readonly string[];
}

/**
 * Make a person's typed text safe to put inside a `LIKE` pattern.
 *
 * `%` and `_` are `LIKE`'s own wildcards and `\` its escape character. This is **not** injection
 * defence — the pattern below is a bound parameter either way, and the guard in
 * `tenant-guard.ts` would reject it if it were not. It is about the pattern meaning what was
 * typed: a colleague whose name contains `_` should find themselves rather than match every
 * name of the same length, and a caller typing `%` should get no rows rather than the roster.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * One row of the member directory: the membership, plus the name the person is known by.
 *
 * `userId` is kept because it is what every work action stores — D16's fix is that a person
 * never has to *type* it, not that it stops existing. `membershipId` is the keyset cursor.
 */
export interface MemberDirectoryEntry {
  readonly membershipId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly role: string;
  readonly status: MembershipStatus;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export class MembershipsRepository {
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: ListMembershipsOptions = {},
  ): Promise<readonly MembershipRow[]> {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const statuses = options.statuses ?? (['active'] as const);

    const predicates = [
      eq(memberships.organizationId, context.organizationId),
      inArray(memberships.status, [...statuses]),
      ne(memberships.role, PLATFORM_SUPPORT_ROLE), // PA-05 (SPEC §3.2): the hidden Support-mode role never shows here.
    ];
    if (options.after) predicates.push(gt(memberships.id, options.after));

    return tenantDrizzle(runner)
      .select()
      .from(memberships)
      .where(and(...predicates))
      .orderBy(asc(memberships.id))
      .limit(limit);
  }

  /**
   * The same list, with the name each row belongs to — D16.
   *
   * `list()` returns `user_id` and nothing a person can read, which is why every screen that
   * needed a member asked somebody to paste a UUID. The name lives on `users.display_name`,
   * so the read is a join, and the join is the reason this is a separate method rather than
   * an option on `list()`: `list()` answers "what are the membership rows", which several
   * internal callers want as rows, and widening its result type would put a second table in
   * every one of their statements for a column they do not read.
   *
   * **Why joining `users` is legitimate.** `users` carries no `organization_id` and is absent
   * from the guard's `TENANT_TABLES` — it is global identity, not tenant data. Only the
   * `memberships` side has a tenant key, and it is anchored to the active context with a
   * bound `organization_id = ?` exactly as `list()` is. The rows a caller can reach are
   * therefore the memberships of their own organization and the user records those rows name,
   * never another tenant's roster: an adjacent tenant's member is unreachable because their
   * membership row is filtered out before the join has anything to attach to.
   *
   * The projection is explicit and deliberately narrow. `users.email` is not in it: a member
   * directory exists so that work can be assigned by name, and an address list is a different
   * decision with different consequences (it is what makes a roster worth exfiltrating). A
   * column added to `users` later is invisible here until somebody chooses to add it.
   *
   * **`q` searches the name, and is still the tenant's search.** The fragment narrows the same
   * statement rather than replacing it: `organization_id = ?` and the status filter are both
   * still there, so a search can only ever reach further into this organization's own roster.
   * The comparison is case-insensitive because `users.display_name` is `utf8mb4_unicode_ci`
   * (spelled out on the table in `0001_tenancy.sql`, not inherited) — a `LOWER()` wrapped round
   * the column would say the same thing while forbidding every index on it.
   */
  async listWithNames(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: MemberDirectoryOptions = {},
  ): Promise<readonly MemberDirectoryEntry[]> {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const statuses = options.statuses ?? (['active'] as const);
    const search = options.q?.trim() ?? '';

    const predicates = [
      eq(memberships.organizationId, context.organizationId),
      inArray(memberships.status, [...statuses]),
      ne(memberships.role, PLATFORM_SUPPORT_ROLE), // PA-05 (SPEC §3.2): the hidden Support-mode role never shows here.
    ];
    if (options.after) predicates.push(gt(memberships.id, options.after));
    if (search !== '') {
      predicates.push(like(users.displayName, `%${escapeLikePattern(search)}%`));
    }
    if (options.onlyUserIds !== undefined) {
      if (options.onlyUserIds.length === 0) return [];
      predicates.push(inArray(memberships.userId, [...options.onlyUserIds]));
    }

    return tenantDrizzle(runner)
      .select({
        membershipId: memberships.id,
        userId: memberships.userId,
        displayName: users.displayName,
        role: memberships.role,
        status: memberships.status,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(...predicates))
      .orderBy(asc(memberships.id))
      .limit(limit);
  }

  /**
   * QA-FIX-P S2 (ADR-0014): the people who share at least one of `projectIds` with the viewer,
   * plus the viewer — a guest's roster, as Asana shows a guest only what is shared with them.
   * Tenant-scoped on `project_memberships.organization_id`.
   */
  async coMemberUserIds(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectIds: readonly string[],
  ): Promise<readonly string[]> {
    if (projectIds.length === 0) return [context.userId];
    const rows = await tenantDrizzle(runner)
      .selectDistinct({ userId: projectMemberships.userId })
      .from(projectMemberships)
      .where(
        and(
          eq(projectMemberships.organizationId, context.organizationId),
          inArray(projectMemberships.projectId, [...projectIds]),
        ),
      );
    return [...new Set([context.userId, ...rows.map((row) => row.userId)])];
  }

  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<MembershipRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.id, membershipId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async requireById(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<MembershipRow> {
    const found = await this.findById(runner, context, membershipId);
    if (!found) throw new MembershipNotFoundError(membershipId);
    return found;
  }

  /**
   * One person's membership in the acting tenant.
   *
   * Scoped by `(organization_id, user_id)`, which is a unique key. Note what this is *not*:
   * a way to ask which organizations a user belongs to. That question spans tenants, has no
   * predicate to carry, and is answered by the membership resolver's bootstrap read — the
   * one place permitted to ask it.
   */
  async findByUserId(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId: string,
  ): Promise<MembershipRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(memberships)
      .where(
        and(eq(memberships.organizationId, context.organizationId), eq(memberships.userId, userId)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Invite someone into the tenant.
   *
   * The row starts `invited`, not `active`: spec section 2 accepts an organization only after
   * confirming an **active** membership, so an unaccepted invitation authorises nothing and
   * the resolver refuses it. `uq_memberships_org_user` makes a second invitation for the same
   * person a duplicate-key error rather than a second row — one membership per person per
   * organization, enforced by the schema rather than by a check-then-insert race.
   */
  /**
   * The founding membership, created `active` rather than `invited`.
   *
   * This is the one place a membership is born already authorising something, and the reason
   * is that there is nobody to accept an invitation from. `invite()` writes `status:
   * 'invited'` precisely so that a grant authorises nothing until the person accepts — a
   * distinction worth having everywhere except here, where the person creating the
   * organization *is* the person being granted, and an invitation they would have to accept
   * from themselves is ceremony rather than a control.
   *
   * It is a separate method rather than a flag on `invite()` so that the exception is
   * countable: one call site, in `ProvisioningService`, and any second one is a diff.
   *
   * The id is supplied by the caller for the same reason `OrganizationsRepository.create`
   * takes one — provisioning builds the `TenantContext` from ids it generated, and this
   * membership's id is inside that context.
   */
  async createFounder(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: { readonly id: string; readonly userId: string; readonly role: string },
  ): Promise<MembershipRow> {
    if (input.id !== context.membershipId) {
      throw new Error(
        'createFounder() was given an id that is not the membership its context names; the ' +
          'row would not be the one that authorised writing it',
      );
    }

    await tenantDrizzle(runner)
      .insert(memberships)
      .values({
        id: input.id,
        organizationId: context.organizationId,
        userId: input.userId,
        role: input.role,
        // The exception, stated in one word.
        status: 'active',
        hasOrgWideScope: defaultOrgWideScope(input.role),
        version: 1,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      });

    return this.requireById(runner, context, input.id);
  }

  /**
   * 60-03 (plan 60 v2 §4.1). The membership of a newly hired AI employee: kind `ai`, created
   * `active` (there is nobody to accept an invitation; the hiring person is the grant), never
   * org-wide (§4.6: "`ai` memberships always have `has_org_wide_scope = 0`"), no workspace scope.
   * The role was already decided by `aiRoleDecision` and the role-grant ceiling; this method only
   * writes. The second place a membership is born active (after {@link createFounder}), and the
   * only one that writes kind `ai`.
   */
  async createAiMember(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: {
      readonly id: string;
      readonly userId: string;
      readonly role: string;
      readonly at: Date;
    },
  ): Promise<MembershipRow> {
    await tenantDrizzle(runner).insert(memberships).values({
      id: input.id,
      organizationId: context.organizationId,
      userId: input.userId,
      role: input.role,
      kind: 'ai',
      status: 'active',
      hasOrgWideScope: false,
      workspaceScopeId: null,
      version: 1,
      createdAt: input.at,
      updatedAt: input.at,
    });
    return this.requireById(runner, context, input.id);
  }

  async invite(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: InviteMembershipInput,
  ): Promise<MembershipRow> {
    const id = uuidv7();

    await tenantDrizzle(runner)
      .insert(memberships)
  /**
   * 60-07 (S6 "Role"). The one writer of an AI member's role (kind `ai`): the AI-employee service
   * has already applied the AI ceiling and the caller's own ceiling. Like {@link changeRole} it
   * bumps `version` and `policy_version` (the authorization epoch), so the AI employee's next call
   * resolves the new role. It never touches a person's membership (`kind = 'ai'` in the write);
   * `false` when no AI membership of this workspace matched.
   */
  async changeAiRole(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    role: string,
    at: Date,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(memberships)
      .set({
        role,
        version: sql`version + 1`,
        policyVersion: sql`policy_version + 1`,
        updatedAt: at,
      })
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.id, membershipId),
          eq(memberships.kind, 'ai'),
        ),
      );
    return result[0].affectedRows === 1;
  }

      .values({
        id,
        // From the context. Not from `input` — there is no such field.
        organizationId: context.organizationId,
        userId: input.userId,
        role: input.role,
        status: 'invited',
        hasOrgWideScope: input.hasOrgWideScope ?? defaultOrgWideScope(input.role),
        workspaceScopeId: input.workspaceScopeId ?? null,
        version: 1,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      });

    return this.requireById(runner, context, id);
  }

  /**
   * Change a role, refusing a stale write.
   *
   * `12-PERMISSION-MATRIX` §5 lists role elevation among the changes needing reauthorization,
   * and section 12 of the isolation spec makes it audit-required. Neither is this method's
   * job — both belong to the command that calls it — but the `version` token is: two admins
   * editing the same membership must not silently overwrite one another, because the loser's
   * intent would disappear without any error to notice.
   */
  async changeRole(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    expectedVersion: number,
    role: InternalRole,
    hasOrgWideScope?: boolean,
    workspaceScopeId?: string | null,
  ): Promise<MembershipRow> {
    // Two independent tokens move on a role change. `version` is optimistic concurrency — it
    // guards this very write against a concurrent one. `policy_version` is the authorization
    // epoch (0023): a role or scope change is precisely the policy-relevant change spec §9
    // keys caches on, so bumping it here is what rotates a stale context minted before the
    // change. It is bumped only here and never by unrelated `updated_at` churn.
    const changes: Record<string, unknown> = {
      role,
      hasOrgWideScope: hasOrgWideScope ?? defaultOrgWideScope(role),
      version: sql`version + 1`,
      policyVersion: sql`policy_version + 1`,
      updatedAt: sql`current_timestamp(3)`,
    };
    // A tri-state: absent leaves the workspace scope untouched (a role change must not silently
    // widen or narrow it), null clears it, an id sets it. Never defaulted from the role name.
    if (workspaceScopeId !== undefined) changes['workspaceScopeId'] = workspaceScopeId;

    // 60-04 interim door (plan 60 v2 §5 test 1): the role of an AI member (`kind = 'ai'`) is never
    // changed here, by any caller (member admin, platform admin, owner transfer). Fail closed in
    // the write itself, so no route can forget it; an AI member reads as not found.
    const result = await tenantDrizzle(runner)
      .update(memberships)
      .set(changes)
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.id, membershipId),
          eq(memberships.version, expectedVersion),
          eq(memberships.kind, 'human'),
        ),
      );

    if (result[0].affectedRows === 0) {
      const current = await this.findById(runner, context, membershipId);
      if (!current || current.kind !== 'human') throw new MembershipNotFoundError(membershipId);
      throw new MembershipVersionConflictError(membershipId, current.version);
    }

    return this.requireById(runner, context, membershipId);
  }

  /**
   * Move a membership to another status, refusing both a stale write and an illegal move.
   *
   * The current status is read inside the same unit of work and the transition is checked
   * against it, then the write itself re-states `version` — so a concurrent change between
   * the read and the write loses rather than slipping through the check.
   */
  async transitionStatus(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    expectedVersion: number,
    to: MembershipStatus,
  ): Promise<MembershipRow> {
    const current = await this.requireById(runner, context, membershipId);
    if (current.version !== expectedVersion) {
      throw new MembershipVersionConflictError(membershipId, current.version);
    }
    if (!ALLOWED_TRANSITIONS[current.status].includes(to)) {
      throw new MembershipTransitionError(current.status, to);
    }

    const result = await tenantDrizzle(runner)
      .update(memberships)
      .set({ status: to, version: sql`version + 1`, updatedAt: sql`current_timestamp(3)` })
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.id, membershipId),
          eq(memberships.version, expectedVersion),
        ),
      );

    if (result[0].affectedRows === 0) {
      const latest = await this.findById(runner, context, membershipId);
      if (!latest) throw new MembershipNotFoundError(membershipId);
      throw new MembershipVersionConflictError(membershipId, latest.version);
    }

    return this.requireById(runner, context, membershipId);
  }

  /**
   * Count active memberships whose role is one of `roles`, optionally excluding one membership.
   *
   * The last-owner guard for offboarding (ADM-13, x121) is expressed with this: offboarding a
   * member whose role holds `org.manage` is refused when they are the last active holder, so
   * the caller counts the *other* active holders and refuses at zero. The exclusion is a
   * predicate here rather than a subtraction at the call site because the member being
   * offboarded may or may not be an org.manage holder themselves — passing their id makes the
   * count "everyone else" whether or not they are in the set.
   *
   * Scoped to the acting tenant exactly as every read here is: `organization_id = ?` is bound
   * from the context, never a parameter. An empty `roles` returns 0 without a query — an
   * `IN ()` is a syntax error in MySQL, and the honest answer to "how many hold none of no
   * roles" is none.
   */
  async countActiveHoldersOfRoles(
    runner: TenantQueryRunner,
    context: TenantContext,
    roles: readonly string[],
    excludeMembershipId?: string,
  ): Promise<number> {
    if (roles.length === 0) return 0;

    const predicates = [
      eq(memberships.organizationId, context.organizationId),
      eq(memberships.status, 'active'),
      inArray(memberships.role, [...roles]),
    ];
    if (excludeMembershipId) predicates.push(ne(memberships.id, excludeMembershipId));

    const rows = await tenantDrizzle(runner)
      .select({ holders: sql<number>`count(*)` })
      .from(memberships)
      .where(and(...predicates));
    return Number(rows[0]?.holders ?? 0);
  }
}
