import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  clientOrganizations,
  invitationProjects,
  invitations,
  organizations,
  projectMemberships,
  projects,
  users,
} from '../../common/database/schema.js';
import type { InvitationRow } from '../../common/database/schema.js';
import type {
  BootstrapQueryRunner,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';

/**
 * Invitations — TEN-003's storage half.
 *
 * `23-ERD-AND-STATE-MACHINES` §9: `pending → accepted | expired | revoked`.
 *
 * ## The states, and why three of them are terminal
 *
 * Only `pending` has outbound transitions. An accepted invitation has produced a membership,
 * a revoked one was withdrawn by a person, and an expired one ran out of time — none of the
 * three is something a later act should be able to undo, because undoing any of them would
 * re-arm a token that has already been used, refused or timed out. Re-inviting somebody is a
 * **new row with a new token**, which §9 also says: "Role/scope change after issuance revokes
 * old invitation and issues a new one."
 *
 * ## Expiry is checked twice, and neither check is redundant
 *
 * `expires_at` is compared **by the database** on the acceptance path, because the application
 * clock and the database clock are different clocks and a grant that expires is not the place
 * to discover they disagree. The `status` column is separately moved to `expired` by
 * `expireOverdue`, so a listing shows the right state without every reader repeating the
 * comparison — and, more importantly, so that a *revoked* invitation whose date has since
 * passed still reads as revoked rather than losing the fact that somebody withdrew it.
 *
 * ## What this repository will not do
 *
 * There is no `findByEmail` that returns the token, no method that returns `token_hash` to a
 * caller, and no update that changes it — the trigger in `0005_invitations.sql` refuses that
 * last one at the database as well. The hash is matched *inside* `findPendingByTokenHash`,
 * where the caller supplies the hash of a token it already holds.
 */

export const INVITATION_STATUSES = ['pending', 'accepted', 'expired', 'revoked'] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

export class InvitationNotFoundError extends Error {
  constructor(readonly invitationId: string) {
    // No organization id in the message, for the reason every other repository gives: a
    // caller probing another tenant must not learn the difference between "does not exist"
    // and "exists elsewhere".
    super(`Invitation ${invitationId} was not found`);
    this.name = 'InvitationNotFoundError';
  }
}

export class InvitationNotPendingError extends Error {
  constructor(
    readonly invitationId: string,
    readonly status: InvitationStatus,
  ) {
    super(`Invitation ${invitationId} is ${status}, not pending`);
    this.name = 'InvitationNotPendingError';
  }
}

export interface IssueInvitationInput {
  readonly email: string;
  readonly role: string;
  /** Null for an internal membership invitation; set for a client one. */
  readonly clientOrganizationId: string | null;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly invitedByUserId: string;
  /** A1 (0218). The inviter's personal note, already trimmed and bounded; null for none. */
  readonly note?: string | null;
}

export interface ListInvitationsOptions {
  readonly after?: string;
  readonly limit?: number;
  readonly statuses?: readonly InvitationStatus[];
  readonly email?: string;
  readonly clientOrganizationId?: string;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/** "Still valid right now", evaluated by the database rather than in JavaScript. */
const NOT_YET_EXPIRED = sql`${invitations.expiresAt} > current_timestamp(3)`;

export interface InvitationPreviewRow {
  readonly role: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly organizationName: string;
  readonly inviterName: string;
  readonly inviterEmail: string;
  readonly clientOrganizationName: string | null;
  /** The address the invitation was sent to — the invitee's own, shown back to them. */
  readonly inviteeEmail: string;
  /** A1 (0218). The inviter's personal note, or null. */
  readonly note: string | null;
}

/** The names the invitation email interpolates — `previewByTokenHash`'s joins, tenant-scoped. */
export interface InvitationMailFactsRow {
  readonly organizationName: string;
  /** `organizations.default_locale` — an Arabic organization's invitation is written in Arabic. */
  readonly organizationLocale: string;
  readonly inviterName: string;
  readonly inviterEmail: string;
  readonly clientOrganizationName: string | null;
}

export class InvitationsRepository {
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: ListInvitationsOptions = {},
  ): Promise<readonly InvitationRow[]> {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);

    const predicates = [eq(invitations.organizationId, context.organizationId)];
    if (options.statuses && options.statuses.length > 0) {
      predicates.push(inArray(invitations.status, [...options.statuses]));
    }
    if (options.email) predicates.push(eq(invitations.email, options.email));
    if (options.clientOrganizationId) {
      predicates.push(eq(invitations.clientOrganizationId, options.clientOrganizationId));
    }
    if (options.after) predicates.push(gt(invitations.id, options.after));

    return tenantDrizzle(runner)
      .select()
      .from(invitations)
      .where(and(...predicates))
      .orderBy(asc(invitations.id))
      .limit(limit);
  }

  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    invitationId: string,
  ): Promise<InvitationRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.organizationId, context.organizationId),
          eq(invitations.id, invitationId),
        ),
      )
      .limit(1);
    return rows[0];
  }

  async requireById(
    runner: TenantQueryRunner,
    context: TenantContext,
    invitationId: string,
  ): Promise<InvitationRow> {
    const row = await this.findById(runner, context, invitationId);
    if (!row) throw new InvitationNotFoundError(invitationId);
    return row;
  }

  /**
   * The names the invitation email shows for one invitation this tenant issued.
   *
   * `previewByTokenHash`'s joins with an ordinary tenant scope instead of the token: the
   * caller here is the issuing transaction, which holds a real `TenantContext` and the row's
   * id, so nothing about the bootstrap path's difficulty applies. `users` is joined without
   * a scope predicate for the reason that method gives — it is in `NON_TENANT_TABLES`.
   */
  async mailFactsById(
    runner: TenantQueryRunner,
    context: TenantContext,
    invitationId: string,
  ): Promise<InvitationMailFactsRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select({
        organizationName: organizations.name,
        organizationLocale: organizations.defaultLocale,
        inviterName: users.displayName,
        inviterEmail: users.email,
        clientOrganizationName: clientOrganizations.name,
      })
      .from(invitations)
      // Each join carries the tenant key bound to the context explicitly, rather than
      // leaning on the guard's equality-chain analysis: `client_organizations` is scoped by
      // `organization_id`, which its join column (`id`) is not, so without the second
      // predicate the guard would rightly refuse the statement.
      .innerJoin(organizations, eq(organizations.id, context.organizationId))
      .innerJoin(users, eq(users.id, invitations.invitedByUserId))
      .leftJoin(
        clientOrganizations,
        and(
          eq(clientOrganizations.id, invitations.clientOrganizationId),
          eq(clientOrganizations.organizationId, context.organizationId),
        ),
      )
      .where(
        and(
          eq(invitations.organizationId, context.organizationId),
          eq(invitations.id, invitationId),
        ),
      )
      .limit(1);

    return rows[0];
  }

  /**
   * Issue an invitation.
   *
   * The token hash is supplied rather than generated here: generating it would put the
   * plaintext token in this file with no way to return it, and the repository would then own a
   * secret it has no reason to hold. `invitation-token.ts` makes the pair; the service hands
   * the hash down and the token back.
   */
  async issue(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: IssueInvitationInput,
  ): Promise<InvitationRow> {
    const id = uuidv7();

    await tenantDrizzle(runner)
      .insert(invitations)
      .values({
        id,
        // From the context. Not from `input` — there is no such field.
        organizationId: context.organizationId,
        clientOrganizationId: input.clientOrganizationId,
        email: input.email,
        role: input.role,
        note: input.note ?? null,
        tokenHash: input.tokenHash,
        status: 'pending',
        expiresAt: input.expiresAt,
        invitedByUserId: input.invitedByUserId,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      });

    return this.requireById(runner, context, id);
  }

  /**
   * Find the pending, unexpired invitation a token names.
   *
   * **No `TenantContext`**, and that is the whole difficulty of this ticket. The person
   * following an invitation link has no membership in the organization — that is what they are
   * accepting — so no context can be resolved for them, and the row itself is what says which
   * organization this is about. The caller runs this through `bootstrapRead`, which is
   * read-only, audited, and allowlisted to this one table.
   *
   * Both conditions are in the `WHERE` clause rather than checked afterwards: a row that is
   * revoked or overdue is not returned at all, so there is no branch in which a caller holds
   * one and forgets to check it.
   */
  async findPendingByTokenHash(
    runner: BootstrapQueryRunner,
    tokenHash: string,
  ): Promise<InvitationRow | undefined> {
    // Through Drizzle, exactly as `MembershipResolver` runs its own bootstrap reads: the
    // guard sees the same statement either way, and the row comes back typed rather than as
    // a shape this file would have to assert.
    const rows = await tenantDrizzle(runner)
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.tokenHash, tokenHash),
          eq(invitations.status, 'pending'),
          NOT_YET_EXPIRED,
        ),
      )
      .limit(1);
    return rows[0];
  }

  /**
   * Mark an invitation accepted, and refuse to do it twice.
   *
   * The `status = 'pending'` predicate is what makes the token single-use. Two requests racing
   * with the same token both find the row on the read above; exactly one of them updates it,
   * because the second one's `WHERE` no longer matches. The loser gets zero affected rows and
   * raises — rather than both proceeding to create a membership each.
   */
  async markAccepted(
    runner: TenantQueryRunner,
    context: TenantContext,
    invitationId: string,
    acceptedByUserId: string,
  ): Promise<InvitationRow> {
    const result = await tenantDrizzle(runner)
      .update(invitations)
      .set({
        status: 'accepted',
        acceptedByUserId,
        acceptedAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .where(
        and(
          eq(invitations.organizationId, context.organizationId),
          eq(invitations.id, invitationId),
          eq(invitations.status, 'pending'),
        ),
      );

    if (result[0].affectedRows === 0) {
      const current = await this.findById(runner, context, invitationId);
      if (!current) throw new InvitationNotFoundError(invitationId);
      throw new InvitationNotPendingError(invitationId, current.status);
    }

    return this.requireById(runner, context, invitationId);
  }

  /** Withdraw a pending invitation. Idempotent only in the sense that it names what it found. */
  async revoke(
    runner: TenantQueryRunner,
    context: TenantContext,
    invitationId: string,
  ): Promise<InvitationRow> {
    const result = await tenantDrizzle(runner)
      .update(invitations)
      .set({
        status: 'revoked',
        revokedAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .where(
        and(
          eq(invitations.organizationId, context.organizationId),
          eq(invitations.id, invitationId),
          eq(invitations.status, 'pending'),
        ),
      );

    if (result[0].affectedRows === 0) {
      const current = await this.findById(runner, context, invitationId);
      if (!current) throw new InvitationNotFoundError(invitationId);
      throw new InvitationNotPendingError(invitationId, current.status);
    }

    return this.requireById(runner, context, invitationId);
  }

  /**
   * Move every overdue pending invitation in this tenant to `expired`.
   *
   * Returns how many moved, so the caller can record it. This is the bookkeeping half of
   * expiry — access is already refused by the `expires_at` predicate on the acceptance path
   * whether or not this has run, so a tenant nobody has swept is not a tenant whose stale
   * invitations still work.
   */
  async expireOverdue(runner: TenantQueryRunner, context: TenantContext): Promise<number> {
    const result = await tenantDrizzle(runner)
      .update(invitations)
      .set({ status: 'expired', updatedAt: sql`current_timestamp(3)` })
      .where(
        and(
          eq(invitations.organizationId, context.organizationId),
          eq(invitations.status, 'pending'),
          sql`${invitations.expiresAt} <= current_timestamp(3)`,
        ),
      );

    return result[0].affectedRows;
  }

  /**
   * F06: withdraw every pending invitation one person issued in this tenant — run inside the
   * offboard transaction and on a role change that takes `org.manage` away, so authority the
   * person delegated does not outlive their own. Returns how many moved, for the audit row.
   */
  async revokePendingIssuedBy(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId: string,
  ): Promise<number> {
    const result = await tenantDrizzle(runner)
      .update(invitations)
      .set({
        status: 'revoked',
        revokedAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .where(
        and(
          eq(invitations.organizationId, context.organizationId),
          eq(invitations.invitedByUserId, userId),
          eq(invitations.status, 'pending'),
        ),
      );
    return result[0].affectedRows;
  }

  /**
   * F36b / N05: how many invitations this tenant created in the last hour (re-issues included),
   * in one **bucket**. `clientOrganizationId: null` counts the internal invitations only (the
   * organization quota); a client organization id counts that client organization's portal
   * invitations only, so a client admin can never exhaust the agency's own quota.
   */
  async countIssuedInLastHour(
    runner: TenantQueryRunner,
    context: TenantContext,
    bucket: { readonly clientOrganizationId: string | null },
  ): Promise<number> {
    const rows = await tenantDrizzle(runner)
      .select({ count: sql<number>`count(*)` })
      .from(invitations)
      .where(
        and(
          eq(invitations.organizationId, context.organizationId),
          bucket.clientOrganizationId === null
            ? sql`${invitations.clientOrganizationId} is null`
            : eq(invitations.clientOrganizationId, bucket.clientOrganizationId),
          sql`${invitations.createdAt} > current_timestamp(3) - interval 1 hour`,
        ),
      );
    return Number(rows[0]?.count ?? 0);
  }

  /** The pending invitations for one address, newest first. Used to refuse a duplicate. */
  async findPendingForEmail(
    runner: TenantQueryRunner,
    context: TenantContext,
    email: string,
    clientOrganizationId: string | null,
  ): Promise<readonly InvitationRow[]> {
    const predicates = [
      eq(invitations.organizationId, context.organizationId),
      eq(invitations.email, email),
      eq(invitations.status, 'pending'),
      NOT_YET_EXPIRED,
    ];
    predicates.push(
      clientOrganizationId === null
        ? sql`${invitations.clientOrganizationId} is null`
        : eq(invitations.clientOrganizationId, clientOrganizationId),
    );

    return tenantDrizzle(runner)
      .select()
      .from(invitations)
      .where(and(...predicates))
      .orderBy(desc(invitations.id));
  }

  /**
   * The invitation a token names, joined to the names `ID-03` has to show.
   *
   * One statement rather than four reads, because every one of them would need the same escape
   * hatch and a single joined statement is one thing for the guard to see rather than four.
   *
   * `users` is joined without appearing in the allowlist, and that is by registry rather than by
   * exception: it is in `NON_TENANT_TABLES`, so the bootstrap runner's table check — which is
   * about *tenant-owned* tables — has nothing to say about it.
   *
   * The same two conditions as `findPendingByTokenHash`, in the same `WHERE`: a revoked or
   * overdue invitation is not previewable either, so the preview cannot become an oracle the
   * acceptance path refuses to be.
   */
  async previewByTokenHash(
    runner: BootstrapQueryRunner,
    tokenHash: string,
  ): Promise<InvitationPreviewRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select({
        role: invitations.role,
        createdAt: invitations.createdAt,
        expiresAt: invitations.expiresAt,
        organizationName: organizations.name,
        inviterName: users.displayName,
        inviterEmail: users.email,
        clientOrganizationName: clientOrganizations.name,
        inviteeEmail: invitations.email,
        note: invitations.note,
      })
      .from(invitations)
      .innerJoin(organizations, eq(organizations.id, invitations.organizationId))
      .innerJoin(users, eq(users.id, invitations.invitedByUserId))
      .leftJoin(clientOrganizations, eq(clientOrganizations.id, invitations.clientOrganizationId))
      .where(
        and(
          eq(invitations.tokenHash, tokenHash),
          eq(invitations.status, 'pending'),
          NOT_YET_EXPIRED,
        ),
      )
      .limit(1);

    return rows[0];
  }
  // ── A1 (0218): the projects an invited person joins on acceptance ─────────

  /**
   * Which of `projectIds` are live (not archived) projects of this tenant. A foreign or unknown id
   * is simply absent, so the caller cannot tell "another tenant's" from "does not exist".
   */
  async liveProjectIds(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectIds: readonly string[],
  ): Promise<readonly string[]> {
    if (projectIds.length === 0) return [];
    const rows = await tenantDrizzle(runner)
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.organizationId, context.organizationId),
          inArray(projects.id, [...projectIds]),
          sql`${projects.archivedAt} is null`,
        ),
      );
    return rows.map((row) => row.id);
  }

  /** Record the projects an invitation adds its invitee to. Written once, at issue. */
  async attachProjects(
    runner: TenantQueryRunner,
    context: TenantContext,
    invitationId: string,
    projectIds: readonly string[],
  ): Promise<void> {
    if (projectIds.length === 0) return;
    await tenantDrizzle(runner)
      .insert(invitationProjects)
      .values(
        projectIds.map((projectId) => ({
          id: uuidv7(),
          organizationId: context.organizationId,
          invitationId,
          projectId,
          createdAt: sql`current_timestamp(3)`,
        })),
      );
  }

  /** The invitation's projects that are still live in the tenant, in id order. */
  async projectIdsFor(
    runner: TenantQueryRunner,
    context: TenantContext,
    invitationId: string,
  ): Promise<readonly string[]> {
    const rows = await tenantDrizzle(runner)
      .select({ projectId: invitationProjects.projectId })
      .from(invitationProjects)
      .innerJoin(
        projects,
        and(
          eq(projects.organizationId, invitationProjects.organizationId),
          eq(projects.id, invitationProjects.projectId),
        ),
      )
      .where(
        and(
          eq(invitationProjects.organizationId, context.organizationId),
          eq(invitationProjects.invitationId, invitationId),
          eq(projects.organizationId, context.organizationId),
          sql`${projects.archivedAt} is null`,
        ),
      )
      .orderBy(asc(invitationProjects.projectId));
    return rows.map((row) => row.projectId);
  }

  /**
   * Put the person who just accepted on each project, skipping one they are already on (a
   * returning member). Returns how many memberships were created.
   */
  async addProjectMemberships(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId: string,
    projectIds: readonly string[],
    role: string,
  ): Promise<number> {
    if (projectIds.length === 0) return 0;
    const existing = await tenantDrizzle(runner)
      .select({ projectId: projectMemberships.projectId })
      .from(projectMemberships)
      .where(
        and(
          eq(projectMemberships.organizationId, context.organizationId),
          eq(projectMemberships.userId, userId),
          inArray(projectMemberships.projectId, [...projectIds]),
        ),
      );
    const already = new Set(existing.map((row) => row.projectId));
    const missing = projectIds.filter((projectId) => !already.has(projectId));
    if (missing.length === 0) return 0;
    await tenantDrizzle(runner)
      .insert(projectMemberships)
      .values(
        missing.map((projectId) => ({
          id: uuidv7(),
          organizationId: context.organizationId,
          projectId,
          userId,
          role,
          createdAt: sql`current_timestamp(3)`,
        })),
      );
    return missing.length;
  }
}
