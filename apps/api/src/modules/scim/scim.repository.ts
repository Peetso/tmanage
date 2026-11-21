import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  ne,
  or,
} from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { PLATFORM_SUPPORT_ROLE } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  memberTeams,
  memberships,
  scimTokens,
  ssoConnections,
  users,
} from '../../common/database/schema.js';
import type { ScimTokenRow } from '../../common/database/schema.js';
import type {
  BootstrapQueryRunner,
  IdentityQueryRunner,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import {
  likePrefix,
  type ScimFilter,
  type ScimGroupRecord,
  type ScimUserRecord,
} from './scim-protocol.js';

/**
 * 54-16 — storage for SCIM. Every statement but {@link ScimRepository.findKeyByHash} and
 * {@link ScimRepository.hasSsoConnection} carries the `organization_id` of the caller's context.
 * Those two are the pre-context reads of the public SCIM routes: they run on
 * `bootstrapRead(['scim_tokens', 'sso_connections'])` and only name the organization the key
 * belongs to. The hidden support role and offboarded members are never visible to SCIM.
 */

export const SCIM_BOOTSTRAP_REASON =
  'resolving which single organization a SCIM bearer key (looked up by its hash) belongs to';
export const SCIM_BOOTSTRAP_TABLES = ['scim_tokens', 'sso_connections'] as const;
export const SCIM_IDENTITY_TABLES = ['users'] as const;

const TOUCH_INTERVAL_MS = 60_000;
export const MAX_LIVE_KEYS = 5;

interface UserRow {
  readonly membershipId: string;
  readonly email: string;
  readonly displayName: string;
  readonly status: string;
  readonly role: string;
  readonly userId: string;
  readonly emailVerifiedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type ScimMember = UserRow;

function visible(context: TenantContext): SQL[] {
  return [
    eq(memberships.organizationId, context.organizationId),
    ne(memberships.role, PLATFORM_SUPPORT_ROLE),
    ne(memberships.status, 'offboarded'),
    // 60-04 door (plan 60 v2 §4.1): provisioning never sees, changes or removes an AI employee;
    // their lifecycle is the AI-employee screens' alone.
    eq(memberships.kind, 'human'),
  ];
}

function emailPredicate(filter: ScimFilter | undefined): SQL | undefined {
  if (!filter) return undefined;
  return filter.op === 'eq'
    ? eq(users.email, filter.value)
    : like(users.email, likePrefix(filter.value));
}

export class ScimRepository {
  // ── Keys ───────────────────────────────────────────────────────────────────

  async findKeyByHash(runner: BootstrapQueryRunner, hash: string): Promise<ScimTokenRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(scimTokens)
      .where(and(eq(scimTokens.tokenHash, hash), isNull(scimTokens.revokedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  async hasSsoConnection(runner: BootstrapQueryRunner, organizationId: string): Promise<boolean> {
    const rows = await tenantDrizzle(runner)
      .select({ id: ssoConnections.id })
      .from(ssoConnections)
      .where(eq(ssoConnections.organizationId, organizationId))
      .limit(1);
    return rows.length > 0;
  }

  async listLiveKeys(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly ScimTokenRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(scimTokens)
      .where(
        and(eq(scimTokens.organizationId, context.organizationId), isNull(scimTokens.revokedAt)),
      )
      .orderBy(desc(scimTokens.id))
      .limit(MAX_LIVE_KEYS * 2);
  }

  async insertKey(
    runner: TenantQueryRunner,
    context: TenantContext,
    row: Omit<ScimTokenRow, 'organizationId' | 'lastUsedAt' | 'revokedAt'>,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(scimTokens)
      .values({
        ...row,
        organizationId: context.organizationId,
        lastUsedAt: null,
        revokedAt: null,
      });
  }

  async revokeKey(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    now: Date,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(scimTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(scimTokens.organizationId, context.organizationId),
          eq(scimTokens.id, id),
          isNull(scimTokens.revokedAt),
        ),
      );
    return result[0].affectedRows === 1;
  }

  async touchKey(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    now: Date,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(scimTokens)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(scimTokens.organizationId, context.organizationId),
          eq(scimTokens.id, id),
          or(
            isNull(scimTokens.lastUsedAt),
            lt(scimTokens.lastUsedAt, new Date(now.getTime() - TOUCH_INTERVAL_MS)),
          ),
        ),
      );
  }

  // ── Users ──────────────────────────────────────────────────────────────────

  private userSelect(runner: TenantQueryRunner) {
    return tenantDrizzle(runner)
      .select({
        membershipId: memberships.id,
        email: users.email,
        displayName: users.displayName,
        status: memberships.status,
        role: memberships.role,
        userId: memberships.userId,
        emailVerifiedAt: users.emailVerifiedAt,
        createdAt: memberships.createdAt,
        updatedAt: memberships.updatedAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId));
  }

  async listUsers(
    runner: TenantQueryRunner,
    context: TenantContext,
    filter: ScimFilter | undefined,
    offset: number,
    limit: number,
  ): Promise<{ readonly rows: readonly UserRow[]; readonly total: number }> {
    const where = and(...visible(context), emailPredicate(filter));
    const [totalRow] = await tenantDrizzle(runner)
      .select({ total: count() })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(where);
    const rows =
      limit === 0
        ? []
        : await this.userSelect(runner)
            .where(where)
            .orderBy(asc(memberships.id))
            .limit(limit)
            .offset(offset);
    return { rows, total: Number(totalRow?.total ?? 0) };
  }

  async findUser(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<UserRow | null> {
    const rows = await this.userSelect(runner)
      .where(and(...visible(context), eq(memberships.id, membershipId)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Visible memberships among `ids`; an id of another organization is simply not found. */
  async findUsers(
    runner: TenantQueryRunner,
    context: TenantContext,
    ids: readonly string[],
  ): Promise<readonly UserRow[]> {
    if (ids.length === 0) return [];
    return this.userSelect(runner).where(
      and(...visible(context), inArray(memberships.id, [...ids])),
    );
  }

  async groupsOf(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipIds: readonly string[],
  ): Promise<Map<string, { id: string; name: string }[]>> {
    const result = new Map<string, { id: string; name: string }[]>();
    if (membershipIds.length === 0) return result;
    const definitions = await this.definitions(runner, context);
    const names = new Map(definitions.map((d) => [d.id, d.name ?? '']));
    const rows = await tenantDrizzle(runner)
      .select({ teamId: memberTeams.teamId, membershipId: memberTeams.membershipId })
      .from(memberTeams)
      .where(
        and(
          eq(memberTeams.organizationId, context.organizationId),
          inArray(memberTeams.membershipId, [...membershipIds]),
        ),
      );
    for (const row of rows) {
      if (!row.teamId || !row.membershipId || !names.has(row.teamId)) continue;
      const list = result.get(row.membershipId) ?? [];
      list.push({ id: row.teamId, name: names.get(row.teamId)! });
      result.set(row.membershipId, list);
    }
    return result;
  }

  async toUserRecords(
    runner: TenantQueryRunner,
    context: TenantContext,
    rows: readonly UserRow[],
  ): Promise<ScimUserRecord[]> {
    const groups = await this.groupsOf(
      runner,
      context,
      rows.map((r) => r.membershipId),
    );
    return rows.map((row) => ({ ...row, groups: groups.get(row.membershipId) ?? [] }));
  }

  /** Only for an account nobody has proved (provisioned and never signed in). */
  async renameUnverifiedUser(
    runner: IdentityQueryRunner,
    userId: string,
    displayName: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(users)
      .set({ displayName, updatedAt: new Date() })
      .where(and(eq(users.id, userId), isNull(users.emailVerifiedAt)));
  }

  // ── Groups (people teams) ──────────────────────────────────────────────────

  private async definitions(runner: TenantQueryRunner, context: TenantContext) {
    return tenantDrizzle(runner)
      .select({ id: memberTeams.id, name: memberTeams.name, createdAt: memberTeams.createdAt })
      .from(memberTeams)
      .where(
        and(eq(memberTeams.organizationId, context.organizationId), isNotNull(memberTeams.name)),
      )
      .orderBy(asc(memberTeams.id));
  }

  async listGroups(
    runner: TenantQueryRunner,
    context: TenantContext,
    filter: ScimFilter | undefined,
  ): Promise<readonly { id: string; name: string; createdAt: Date }[]> {
    const all = (await this.definitions(runner, context)).map((d) => ({
      ...d,
      name: d.name ?? '',
    }));
    if (!filter) return all;
    const wanted = filter.value.toLowerCase();
    return all.filter((d) =>
      filter.op === 'eq'
        ? d.name.toLowerCase() === wanted
        : d.name.toLowerCase().startsWith(wanted),
    );
  }

  async groupMembers(
    runner: TenantQueryRunner,
    context: TenantContext,
    teamId: string,
  ): Promise<readonly { membershipId: string; email: string }[]> {
    return tenantDrizzle(runner)
      .select({ membershipId: memberships.id, email: users.email })
      .from(memberTeams)
      .innerJoin(
        memberships,
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.id, memberTeams.membershipId),
        ),
      )
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberTeams.organizationId, context.organizationId),
          eq(memberTeams.teamId, teamId),
          ne(memberships.role, PLATFORM_SUPPORT_ROLE),
          ne(memberships.status, 'offboarded'),
          eq(memberships.kind, 'human'),
        ),
      )
      .orderBy(asc(memberships.id));
  }

  async toGroupRecord(
    runner: TenantQueryRunner,
    context: TenantContext,
    team: { id: string; name: string; createdAt: Date },
  ): Promise<ScimGroupRecord> {
    return { ...team, members: await this.groupMembers(runner, context, team.id) };
  }

  async renameGroup(
    runner: TenantQueryRunner,
    context: TenantContext,
    teamId: string,
    name: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(memberTeams)
      .set({ name })
      .where(
        and(
          eq(memberTeams.organizationId, context.organizationId),
          eq(memberTeams.id, teamId),
          isNotNull(memberTeams.name),
        ),
      );
  }

  /** The team's assignment rows, then its definition row. */
  async deleteGroup(
    runner: TenantQueryRunner,
    context: TenantContext,
    teamId: string,
  ): Promise<void> {
    const db = tenantDrizzle(runner);
    await db
      .delete(memberTeams)
      .where(
        and(eq(memberTeams.organizationId, context.organizationId), eq(memberTeams.teamId, teamId)),
      );
    await db
      .delete(memberTeams)
      .where(
        and(
          eq(memberTeams.organizationId, context.organizationId),
          eq(memberTeams.id, teamId),
          isNotNull(memberTeams.name),
        ),
      );
  }
}
