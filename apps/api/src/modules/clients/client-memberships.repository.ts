import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import type { ClientRole } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  type MEMBERSHIP_STATUS,
  clientMemberships,
  memberships,
  users,
} from '../../common/database/schema.js';
import type { ClientMembershipRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Client memberships — the row that lets an external person see anything at all.
 *
 * Follows `ProjectsRepository`: `TenantContext` as the scoping parameter, no `organizationId`
 * on any input type, keyset pagination, optimistic concurrency, not-found rather than conflict
 * for a caller in the wrong tenant. It is closest in shape to `MembershipsRepository`, and the
 * differences from that file are the interesting part.
 *
 * ## Three ways this differs from an internal membership, all from the schema
 *
 * 1. **Access is time-bounded.** `expires_at` is a first-class column. An internal membership
 *    has no such column and is ended by a status change; a client membership can simply stop
 *    working at a moment nobody performs an action at. That is intentional — `49-PRICING`'s
 *    `CLIENT_MEMBERSHIP_DEFAULT_EXPIRY_DAYS` makes a bounded grant the default rather than the
 *    exception — and it means **every** read that decides access has to test expiry, not just
 *    status. {@link ACTIVE_NOW} is that predicate, defined once so the two places that need it
 *    cannot drift.
 * 2. **The role is a `ClientRole`.** Typed, so an internal role cannot be written into this
 *    table by a caller who passed the wrong string. `12-PERMISSION-MATRIX` §2 gives every
 *    client role "View internal project: Never", and that ceiling is only meaningful if the
 *    role column really does hold a client role.
 * 3. **Concurrency is `updated_at`, not `version`.** `client_memberships` has no version
 *    column. Same position as `projects` and `client_organizations`; `memberships` and
 *    `work_items` do have one and use it.
 *
 * ## Why `offboarded` is terminal here too
 *
 * `packages/domain`'s offboarding machine records `OFFBOARDING_NEVER_AUTO_RESTORES_ACCESS`,
 * and this is the client-side half of it. Re-admitting someone is a new membership — a
 * deliberate act, freshly audited, with a new id — not the reversal of a status flag. It
 * matters more here than internally: a client contact who left the client company is exactly
 * the person a bulk edit should never silently readmit.
 *
 * Archiving the parent `client_organizations` row does **not** offboard its members, and this
 * repository deliberately offers no method that does. A cascade would make ending a client
 * relationship look like one act in the audit trail when it revoked access for several named
 * people, and each of those revocations is separately audit-required (spec §12).
 */

export type ClientMembershipStatus = (typeof MEMBERSHIP_STATUS)[number];

/**
 * Which status changes are permitted. Absent pairs are refused, and `offboarded` has no
 * outbound entry at all.
 */
const ALLOWED_TRANSITIONS: Readonly<
  Record<ClientMembershipStatus, readonly ClientMembershipStatus[]>
> = Object.freeze({
  invited: ['active', 'offboarded'],
  active: ['suspended', 'offboarded'],
  suspended: ['active', 'offboarded'],
  offboarded: [],
});

export class ClientMembershipNotFoundError extends Error {
  constructor(readonly clientMembershipId: string) {
    super(`Client membership ${clientMembershipId} was not found`);
    this.name = 'ClientMembershipNotFoundError';
  }
}

export class ClientMembershipVersionConflictError extends Error {
  constructor(
    readonly clientMembershipId: string,
    readonly expectedVersion: number,
  ) {
    super(
      `Client membership ${clientMembershipId} was modified concurrently ` +
        `(expected version ${expectedVersion})`,
    );
    this.name = 'ClientMembershipVersionConflictError';
  }
}

export class ClientMembershipTransitionError extends Error {
  constructor(
    readonly from: ClientMembershipStatus,
    readonly to: ClientMembershipStatus,
  ) {
    super(`A client membership cannot move from ${from} to ${to}`);
    this.name = 'ClientMembershipTransitionError';
  }
}

export interface InviteClientMembershipInput {
  readonly clientOrganizationId: string;
  readonly userId: string;
  readonly role: ClientRole;
  /**
   * When this grant stops working. `null` means open-ended, which is a deliberate choice a
   * caller has to make rather than the default — the parameter is required for exactly that
   * reason. `49-PRICING` sets a default number of days; converting that into a date is the
   * service's job, because the repository must not invent a policy the caller did not state.
   */
  readonly expiresAt: Date | null;
}

export interface ListClientMembershipsOptions {
  readonly after?: string;
  readonly limit?: number;
  /** Restrict to one client organization. Omitted, the whole tenant's client members. */
  readonly clientOrganizationId?: string;
  /** Defaults to active memberships only; the invited and suspended are opt-in. */
  readonly statuses?: readonly ClientMembershipStatus[];
  /**
   * Include grants whose `expires_at` has passed. Off by default, because a list of client
   * members is almost always a list of people who can see something *now*.
   */
  readonly includeExpired?: boolean;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/**
 * "Not expired as of now" — `expires_at IS NULL OR expires_at > now(3)`.
 *
 * Defined once and used by every read that decides access, so the open-ended case and the
 * bounded case cannot diverge. Evaluated by the **database**, not in JavaScript: the
 * application clock and the database clock are different clocks, and a grant that expires is
 * not a place to discover that they disagree.
 */
const ACTIVE_NOW = sql`(${clientMemberships.expiresAt} is null or ${clientMemberships.expiresAt} > current_timestamp(3))`;

export class ClientMembershipsRepository {
  /**
   * 2026-10-31 live-test fix (Clients · company detail): the display name and email of the given
   * client members, for the staff-side People card. Only rows that hold a client membership in
   * the acting tenant are joined, so an arbitrary user id names nobody.
   */
  async peopleFor(
    runner: TenantQueryRunner,
    context: TenantContext,
    userIds: readonly string[],
  ): Promise<readonly { userId: string; displayName: string; email: string }[]> {
    if (userIds.length === 0) return [];
    return tenantDrizzle(runner)
      .selectDistinct({
        userId: clientMemberships.userId,
        displayName: users.displayName,
        email: users.email,
      })
      .from(clientMemberships)
      .innerJoin(users, eq(users.id, clientMemberships.userId))
      .where(
        and(
          eq(clientMemberships.organizationId, context.organizationId),
          inArray(clientMemberships.userId, [...userIds]),
        ),
      );
  }

  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: ListClientMembershipsOptions = {},
  ): Promise<readonly ClientMembershipRow[]> {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const statuses = options.statuses ?? (['active'] as const);

    const predicates = [
      eq(clientMemberships.organizationId, context.organizationId),
      inArray(clientMemberships.status, [...statuses]),
    ];
    if (options.clientOrganizationId) {
      predicates.push(eq(clientMemberships.clientOrganizationId, options.clientOrganizationId));
    }
    if (!options.includeExpired) predicates.push(ACTIVE_NOW);
    if (options.after) predicates.push(gt(clientMemberships.id, options.after));

    return tenantDrizzle(runner)
      .select()
      .from(clientMemberships)
      .where(and(...predicates))
      .orderBy(asc(clientMemberships.id))
      .limit(limit);
  }

  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    clientMembershipId: string,
  ): Promise<ClientMembershipRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(clientMemberships)
      .where(
        and(
          eq(clientMemberships.organizationId, context.organizationId),
          eq(clientMemberships.id, clientMembershipId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Does this user hold an active **internal** membership in the acting tenant? (audit F27)
   *
   * A person with both an active internal and an active client membership in one tenant cannot be
   * resolved to a single principal (`principal_kind_ambiguous`), which locks them out of the whole
   * tenant. So no client membership may be created for, or activated on, such a user. Tenant-scoped
   * by `organization_id`; answers only yes/no and returns nothing about the membership.
   */
  async userHasActiveInternalMembership(
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

  async requireById(
    runner: TenantQueryRunner,
    context: TenantContext,
    clientMembershipId: string,
  ): Promise<ClientMembershipRow> {
    const found = await this.findById(runner, context, clientMembershipId);
    if (!found) throw new ClientMembershipNotFoundError(clientMembershipId);
    return found;
  }

  /**
   * One person's client membership in a named client organization, within the acting tenant.
   *
   * Scoped by `(organization_id, client_organization_id, user_id)`, which is a unique key.
   * Note what this is *not*: a way to ask which client organizations a user belongs to across
   * tenants. That question has no predicate to carry and is answered by the membership
   * resolver's bootstrap read — the one place permitted to ask it.
   *
   * Returns the row whatever its status or expiry. Deciding access is the caller's job and it
   * needs to see *why* the answer is no; {@link isActiveNow} is the check, kept separate so
   * that "found" and "usable" never collapse into one boolean by accident.
   */
  async findByUser(
    runner: TenantQueryRunner,
    context: TenantContext,
    clientOrganizationId: string,
    userId: string,
  ): Promise<ClientMembershipRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(clientMemberships)
      .where(
        and(
          eq(clientMemberships.organizationId, context.organizationId),
          eq(clientMemberships.clientOrganizationId, clientOrganizationId),
          eq(clientMemberships.userId, userId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Invite a client contact.
   *
   * The row starts `invited`, not `active`: spec §2 accepts an organization only after
   * confirming an **active** membership, so an unaccepted invitation authorises nothing and
   * the resolver refuses it. `uq_client_memberships_identity` makes a second invitation for
   * the same person in the same client organization a duplicate-key error rather than a second
   * row — enforced by the schema rather than by a check-then-insert race.
   *
   * The client organization is *not* checked to belong to the tenant here. That is not an
   * oversight: `fk_client_memberships_client_org_tenant` is a composite foreign key including
   * `organization_id`, so the database refuses a client organization from another tenant. A
   * service-layer check would duplicate a guarantee that already cannot be bypassed, and would
   * drift from it.
   */
  async invite(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: InviteClientMembershipInput,
  ): Promise<ClientMembershipRow> {
    const id = uuidv7();

    await tenantDrizzle(runner)
      .insert(clientMemberships)
      .values({
        id,
        // From the context. Not from `input` — there is no such field.
        organizationId: context.organizationId,
        clientOrganizationId: input.clientOrganizationId,
        userId: input.userId,
        role: input.role,
        status: 'invited',
        expiresAt: input.expiresAt,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      });

    return this.requireById(runner, context, id);
  }

  /** Change a client role, refusing a stale write. */
  async changeRole(
    runner: TenantQueryRunner,
    context: TenantContext,
    clientMembershipId: string,
    expectedUpdatedAt: Date,
    role: ClientRole,
  ): Promise<ClientMembershipRow> {
    const result = await tenantDrizzle(runner)
      .update(clientMemberships)
      .set({ role, updatedAt: sql`current_timestamp(3)` })
      .where(
        and(
          eq(clientMemberships.organizationId, context.organizationId),
          eq(clientMemberships.id, clientMembershipId),
          eq(clientMemberships.updatedAt, expectedUpdatedAt),
        ),
      );

    if (result[0].affectedRows === 0) {
      const current = await this.findById(runner, context, clientMembershipId);
      if (!current) throw new ClientMembershipNotFoundError(clientMembershipId);
      throw new ClientMembershipVersionConflictError(
        clientMembershipId,
        current.updatedAt.getTime(),
      );
    }

    return this.requireById(runner, context, clientMembershipId);
  }

  /**
   * Change when the grant expires, refusing a stale write.
   *
   * Setting it to `null` makes the grant open-ended, and that is permitted rather than
   * refused — some client relationships genuinely are — but it is a distinct, auditable act
   * with its own call rather than a side effect of editing a role. Extending an expiry is the
   * same call, and the same audit event, as removing one.
   */
  async setExpiry(
    runner: TenantQueryRunner,
    context: TenantContext,
    clientMembershipId: string,
    expectedUpdatedAt: Date,
    expiresAt: Date | null,
  ): Promise<ClientMembershipRow> {
    const result = await tenantDrizzle(runner)
      .update(clientMemberships)
      .set({ expiresAt, updatedAt: sql`current_timestamp(3)` })
      .where(
        and(
          eq(clientMemberships.organizationId, context.organizationId),
          eq(clientMemberships.id, clientMembershipId),
          eq(clientMemberships.updatedAt, expectedUpdatedAt),
        ),
      );

    if (result[0].affectedRows === 0) {
      const current = await this.findById(runner, context, clientMembershipId);
      if (!current) throw new ClientMembershipNotFoundError(clientMembershipId);
      throw new ClientMembershipVersionConflictError(
        clientMembershipId,
        current.updatedAt.getTime(),
      );
    }

    return this.requireById(runner, context, clientMembershipId);
  }

  /**
   * Move a client membership to another status, refusing both a stale write and an illegal
   * move.
   *
   * The current status is read inside the same unit of work and the transition is checked
   * against it, then the write itself re-states `updated_at` — so a concurrent change between
   * the read and the write loses rather than slipping through the check.
   */
  async transitionStatus(
    runner: TenantQueryRunner,
    context: TenantContext,
    clientMembershipId: string,
    expectedUpdatedAt: Date,
    to: ClientMembershipStatus,
  ): Promise<ClientMembershipRow> {
    const current = await this.requireById(runner, context, clientMembershipId);
    const from = current.status;

    if (!ALLOWED_TRANSITIONS[from].includes(to)) {
      throw new ClientMembershipTransitionError(from, to);
    }

    const result = await tenantDrizzle(runner)
      .update(clientMemberships)
      .set({ status: to, updatedAt: sql`current_timestamp(3)` })
      .where(
        and(
          eq(clientMemberships.organizationId, context.organizationId),
          eq(clientMemberships.id, clientMembershipId),
          eq(clientMemberships.updatedAt, expectedUpdatedAt),
        ),
      );

    if (result[0].affectedRows === 0) {
      const live = await this.findById(runner, context, clientMembershipId);
      if (!live) throw new ClientMembershipNotFoundError(clientMembershipId);
      throw new ClientMembershipVersionConflictError(clientMembershipId, live.updatedAt.getTime());
    }

    return this.requireById(runner, context, clientMembershipId);
  }
}

/**
 * Whether a row grants access right now: `active` **and** not past its expiry.
 *
 * Exported so a caller that already holds a row does not have to re-implement the two halves,
 * and so the two halves are never checked separately by accident — a grant that is `active`
 * but expired is the exact shape of a client who should have lost access last month.
 *
 * Note it compares against the **caller's** clock, unlike {@link ACTIVE_NOW}, which the
 * database evaluates. Use this for a row already in hand; prefer a scoped query with the
 * predicate when the decision is what to load at all.
 */
export function isActiveNow(row: ClientMembershipRow, now: Date = new Date()): boolean {
  if (row.status !== 'active') return false;
  return row.expiresAt === null || row.expiresAt.getTime() > now.getTime();
}
