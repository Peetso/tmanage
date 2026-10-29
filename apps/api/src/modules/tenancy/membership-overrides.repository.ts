import { and, asc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { CAPABILITIES, uuidv7 } from '@tmanage/domain';
import type { Capability, PermissionOverrides } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  membershipPermissionOverrides,
  memberships,
  projectMemberships,
  projects,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { ValidOverride } from './override-ceiling.js';

/**
 * platform-admin v2 · PA-01 — the data half of per-member permission overrides (0242).
 *
 * Every statement carries `organization_id = context.organizationId`, never a value from the
 * request, so a membership id from another organization matches nothing. Removing an override
 * sets `revoked_at` (the app credential has no DELETE on this table). A change also bumps the
 * member's `policy_version`, the authorization epoch a cached context is keyed on, so the next
 * request sees the new overrides.
 */

const KNOWN: ReadonlySet<string> = new Set(CAPABILITIES);

export const NO_OVERRIDES: PermissionOverrides = Object.freeze({
  allow: Object.freeze([]) as readonly Capability[],
  deny: Object.freeze([]) as readonly Capability[],
});

/** One override row as the screens show it. */
export interface MembershipOverrideRecord {
  readonly id: string;
  readonly capability: Capability;
  readonly effect: 'allow' | 'deny';
  readonly reason: string | null;
  readonly expiresAt: Date | null;
  readonly createdBy: string;
  readonly createdAt: Date;
  /** False once `expires_at` has passed; an expired row is shown greyed, not applied. */
  readonly live: boolean;
}

/** The member an override set is about. */
export interface OverrideMember {
  readonly id: string;
  readonly userId: string;
  readonly role: string;
  readonly status: string;
  readonly hasOrgWideScope: boolean;
  readonly workspaceScopeId: string | null;
}

export interface OverrideChange {
  readonly added: readonly ValidOverride[];
  readonly revoked: readonly MembershipOverrideRecord[];
}

function isEffect(value: string): value is 'allow' | 'deny' {
  return value === 'allow' || value === 'deny';
}

/** Group live rows into the principal's `{allow, deny}`; unknown strings grant nothing. */
export function toPermissionOverrides(
  rows: readonly { readonly capability: string; readonly effect: string }[],
): PermissionOverrides {
  if (rows.length === 0) return NO_OVERRIDES;
  const allow: Capability[] = [];
  const deny: Capability[] = [];
  for (const row of rows) {
    if (!KNOWN.has(row.capability)) continue;
    if (row.effect === 'allow') allow.push(row.capability as Capability);
    else if (row.effect === 'deny') deny.push(row.capability as Capability);
  }
  return { allow, deny };
}

export class MembershipOverridesRepository {
  /** The live overrides (not revoked, not expired by the server's clock) of one membership. */
  async liveOverrides(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    audience: 'internal' | 'client' = 'internal',
  ): Promise<PermissionOverrides> {
    const rows = await tenantDrizzle(runner)
      .select({
        capability: membershipPermissionOverrides.capability,
        effect: membershipPermissionOverrides.effect,
      })
      .from(membershipPermissionOverrides)
      .where(
        and(
          eq(membershipPermissionOverrides.organizationId, context.organizationId),
          eq(membershipPermissionOverrides.membershipId, membershipId),
          eq(membershipPermissionOverrides.audience, audience),
          isNull(membershipPermissionOverrides.revokedAt),
          or(
            isNull(membershipPermissionOverrides.expiresAt),
            gt(membershipPermissionOverrides.expiresAt, sql`now(3)`),
          ),
        ),
      )
      .orderBy(asc(membershipPermissionOverrides.capability));
    return toPermissionOverrides(rows);
  }

  /** Every unrevoked override of one membership, live and expired, for the screens. */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    now: Date = new Date(),
  ): Promise<readonly MembershipOverrideRecord[]> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(membershipPermissionOverrides)
      .where(
        and(
          eq(membershipPermissionOverrides.organizationId, context.organizationId),
          eq(membershipPermissionOverrides.membershipId, membershipId),
          eq(membershipPermissionOverrides.audience, 'internal'),
          isNull(membershipPermissionOverrides.revokedAt),
        ),
      )
      .orderBy(asc(membershipPermissionOverrides.createdAt), asc(membershipPermissionOverrides.id));
    const out: MembershipOverrideRecord[] = [];
    for (const row of rows) {
      if (!KNOWN.has(row.capability) || !isEffect(row.effect)) continue;
      out.push({
        id: row.id,
        capability: row.capability as Capability,
        effect: row.effect,
        reason: row.reason,
        expiresAt: row.expiresAt,
        createdBy: row.createdBy,
        createdAt: row.createdAt,
        live: row.expiresAt === null || row.expiresAt.getTime() > now.getTime(),
      });
    }
    return out;
  }

  /** The internal membership the overrides are for, in the acting tenant, or undefined. */
  async findMember(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<OverrideMember | undefined> {
    const rows = await tenantDrizzle(runner)
      .select({
        id: memberships.id,
        userId: memberships.userId,
        role: memberships.role,
        status: memberships.status,
        hasOrgWideScope: memberships.hasOrgWideScope,
        workspaceScopeId: memberships.workspaceScopeId,
      })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.id, membershipId),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /**
   * The projects a member reaches through relations — the same three routes the principal
   * repository walks for the caller (org-wide: none needed; workspace scope; project membership),
   * here for another member of the acting tenant.
   */
  async projectIdsOf(
    runner: TenantQueryRunner,
    context: TenantContext,
    member: OverrideMember,
  ): Promise<readonly string[]> {
    if (member.hasOrgWideScope) return [];
    const db = tenantDrizzle(runner);
    if (member.workspaceScopeId !== null) {
      const rows = await db
        .select({ projectId: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.organizationId, context.organizationId),
            eq(projects.workspaceId, member.workspaceScopeId),
          ),
        )
        .orderBy(asc(projects.id));
      return rows.map((row) => row.projectId);
    }
    const rows = await db
      .select({ projectId: projectMemberships.projectId })
      .from(projectMemberships)
      .where(
        and(
          eq(projectMemberships.organizationId, context.organizationId),
          eq(projectMemberships.userId, member.userId),
        ),
      )
      .orderBy(asc(projectMemberships.projectId));
    return rows.map((row) => row.projectId);
  }

  /**
   * Make the member's unrevoked overrides exactly `next`. A row whose capability, effect, reason
   * and expiry all match is kept; every other unrevoked row is revoked; every new entry is
   * inserted. Call inside a transaction. Bumps the member's `policy_version` when anything moved.
   */
  async replace(
    tx: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    next: readonly ValidOverride[],
    actorUserId: string,
  ): Promise<OverrideChange> {
    const current = await this.list(tx, context, membershipId);
    const same = (row: MembershipOverrideRecord, entry: ValidOverride) =>
      row.capability === entry.capability &&
      row.effect === entry.effect &&
      row.reason === entry.reason &&
      (row.expiresAt?.getTime() ?? null) === (entry.expiresAt?.getTime() ?? null);

    const revoked = current.filter((row) => !next.some((entry) => same(row, entry)));
    const added = next.filter((entry) => !current.some((row) => same(row, entry)));
    const db = tenantDrizzle(tx);

    for (const row of revoked) {
      await db
        .update(membershipPermissionOverrides)
        .set({ revokedAt: sql`now(3)`, revokedBy: actorUserId })
        .where(
          and(
            eq(membershipPermissionOverrides.organizationId, context.organizationId),
            eq(membershipPermissionOverrides.id, row.id),
            isNull(membershipPermissionOverrides.revokedAt),
          ),
        );
    }
    for (const entry of added) {
      await db.insert(membershipPermissionOverrides).values({
        id: uuidv7(),
        organizationId: context.organizationId,
        membershipId,
        audience: 'internal',
        capability: entry.capability,
        effect: entry.effect,
        reason: entry.reason,
        expiresAt: entry.expiresAt,
        createdBy: actorUserId,
        createdAt: sql`current_timestamp(3)`,
      });
    }
    if (revoked.length > 0 || added.length > 0) {
      await db
        .update(memberships)
        .set({ policyVersion: sql`${memberships.policyVersion} + 1` })
        .where(
          and(
            eq(memberships.organizationId, context.organizationId),
            eq(memberships.id, membershipId),
          ),
        );
    }
    return { added, revoked };
  }
}
