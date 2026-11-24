import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { memberships, personalAccessTokens, users } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * 60-07 — the two reads behind an AI employee's connections that touch this module's side of the
 * schema (25-AUTH-AND-TENANT-ISOLATION §6: only a repository holds a driver handle). Connector
 * reads live in the OAuth module's `GrantsRepository`, which owns those tables.
 */

export interface KeySummary {
  readonly live: number;
  readonly lastCalledAt: Date | null;
}

/** Live agent keys and their latest use, per membership, in one grouped read. */
export async function keySummaries(
  runner: TenantQueryRunner,
  context: TenantContext,
  membershipIds: readonly string[],
  at: Date,
): Promise<ReadonlyMap<string, KeySummary>> {
  if (membershipIds.length === 0) return new Map();
  const live = and(
    isNull(personalAccessTokens.revokedAt),
    or(isNull(personalAccessTokens.expiresAt), gt(personalAccessTokens.expiresAt, at)),
  );
  const rows = await tenantDrizzle(runner)
    .select({
      membershipId: personalAccessTokens.membershipId,
      live: sql<number>`sum(case when ${live} then 1 else 0 end)`,
      lastUsedAt: sql<Date | string | null>`max(${personalAccessTokens.lastUsedAt})`,
    })
    .from(personalAccessTokens)
    .where(
      and(
        eq(personalAccessTokens.organizationId, context.organizationId),
        inArray(personalAccessTokens.membershipId, [...membershipIds]),
      ),
    )
    .groupBy(personalAccessTokens.membershipId);
  return new Map(
    rows.map((row) => [
      row.membershipId,
      { live: Number(row.live ?? 0), lastCalledAt: toDate(row.lastUsedAt) },
    ]),
  );
}

/**
 * Display names of members of this workspace, by membership id (the "Added by" column). A
 * membership of another workspace names nobody.
 */
export async function memberDisplayNames(
  runner: TenantQueryRunner,
  context: TenantContext,
  membershipIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const ids = [...new Set(membershipIds)];
  if (ids.length === 0) return new Map();
  const rows = await tenantDrizzle(runner)
    .select({ membershipId: memberships.id, displayName: users.displayName })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(eq(memberships.organizationId, context.organizationId), inArray(memberships.id, ids)),
    );
  return new Map(rows.map((row) => [row.membershipId, row.displayName]));
}

/** A `max()` comes back as a string from MySQL/MariaDB; read it as UTC. */
function toDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
