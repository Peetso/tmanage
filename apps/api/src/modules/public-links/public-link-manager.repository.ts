import {
  and,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  or,
} from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  deliverables,
  deliverableVersions,
  publicLinks,
  quotes,
  users,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { PublicLinkStateFilter } from '@tmanage/domain';

/**
 * 56-07p — the reads and the one write behind Settings · Public links, over the existing
 * `public_links` table (0257): no new table, no migration.
 *
 * Every statement is bound to `context.organizationId`; the joined objects (a deliverable version
 * and its deliverable, a quote) are joined on that same organization, so a link can only ever be
 * named by an object of its own workspace. `users` is a non-tenant table joined by id for the
 * creator's and the revoker's names. Nothing secret is selected: no token hash, no hint, no code.
 * Revoking is NOT here — it goes through {@link PublicLinksRepository.revoke}, the one revoke path.
 */

export interface ManagedLinkFilter {
  /** The kinds this workspace issues; never empty (the service answers an empty list itself). */
  readonly kinds: readonly string[];
  readonly kind: string | null;
  readonly createdBy: string | null;
  readonly search: string | null;
  readonly state: PublicLinkStateFilter;
  readonly now: Date;
  /** `now` + the ending-soon window: a live link ending before this is "ending soon". */
  readonly endingBefore: Date;
}

/** One link as the manager reads it — metadata only. */
export interface ManagedLinkRow {
  readonly id: string;
  readonly kind: string;
  readonly targetType: string;
  readonly projectId: string | null;
  readonly deliverableId: string | null;
  readonly deliverableTitle: string | null;
  readonly versionNo: number | null;
  readonly quoteId: string | null;
  readonly quoteTitle: string | null;
  readonly quoteNumber: string | null;
  readonly audienceEmail: string | null;
  readonly createdByUserId: string | null;
  readonly createdByName: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly lastOpenedAt: Date | null;
  readonly uses: number;
  readonly maxUses: number | null;
  readonly decision: string | null;
  readonly revokedAt: Date | null;
  readonly revokedByName: string | null;
}

const creator = alias(users, 'link_creator');
const revoker = alias(users, 'link_revoker');

/** `%` and `_` typed by a person are letters, not wildcards. */
function contains(text: string): string {
  return `%${text.replace(/[\\%_]/gu, (c) => `\\${c}`)}%`;
}

function live(now: Date): SQL {
  return and(
    isNull(publicLinks.revokedAt),
    isNull(publicLinks.decision),
    gt(publicLinks.expiresAt, now),
    or(isNull(publicLinks.maxUses), lt(publicLinks.uses, publicLinks.maxUses)),
  ) as SQL;
}

function ended(now: Date): SQL {
  return or(
    isNotNull(publicLinks.revokedAt),
    isNotNull(publicLinks.decision),
    lte(publicLinks.expiresAt, now),
    and(isNotNull(publicLinks.maxUses), gte(publicLinks.uses, publicLinks.maxUses)),
  ) as SQL;
}

function stateClause(filter: ManagedLinkFilter, state: PublicLinkStateFilter): SQL | undefined {
  if (state === 'active') return live(filter.now);
  if (state === 'ending_soon') {
    return and(live(filter.now), lte(publicLinks.expiresAt, filter.endingBefore));
  }
  if (state === 'ended') return ended(filter.now);
  return undefined;
}

function where(
  context: TenantContext,
  filter: ManagedLinkFilter,
  state: PublicLinkStateFilter,
): SQL {
  const search = filter.search === null ? null : contains(filter.search);
  return and(
    eq(publicLinks.organizationId, context.organizationId),
    inArray(publicLinks.kind, [...filter.kinds]),
    filter.kind === null ? undefined : eq(publicLinks.kind, filter.kind),
    filter.createdBy === null ? undefined : eq(publicLinks.createdByUserId, filter.createdBy),
    search === null
      ? undefined
      : or(
          like(deliverables.title, search),
          like(quotes.title, search),
          like(publicLinks.audienceEmail, search),
          like(creator.displayName, search),
        ),
    stateClause(filter, state),
  ) as SQL;
}

export class PublicLinkManagerRepository {
  /** One page of the workspace's links, newest first, with the total that matches. */
  async page(
    runner: TenantQueryRunner,
    context: TenantContext,
    filter: ManagedLinkFilter,
    page: number,
    pageSize: number,
  ): Promise<{ readonly rows: readonly ManagedLinkRow[]; readonly total: number }> {
    const rows = await tenantDrizzle(runner)
      .select({
        id: publicLinks.id,
        kind: publicLinks.kind,
        targetType: publicLinks.targetType,
        projectId: deliverableVersions.projectId,
        deliverableId: deliverableVersions.deliverableId,
        deliverableTitle: deliverables.title,
        versionNo: deliverableVersions.versionNo,
        quoteId: quotes.id,
        quoteTitle: quotes.title,
        quoteNumber: quotes.number,
        audienceEmail: publicLinks.audienceEmail,
        createdByUserId: publicLinks.createdByUserId,
        createdByName: creator.displayName,
        createdAt: publicLinks.createdAt,
        expiresAt: publicLinks.expiresAt,
        lastOpenedAt: publicLinks.lastOpenedAt,
        uses: publicLinks.uses,
        maxUses: publicLinks.maxUses,
        decision: publicLinks.decision,
        revokedAt: publicLinks.revokedAt,
        revokedByName: revoker.displayName,
      })
      .from(publicLinks)
      .leftJoin(deliverableVersions, ON.version)
      .leftJoin(deliverables, ON.deliverable)
      .leftJoin(quotes, ON.quote)
      .leftJoin(creator, ON.creator)
      .leftJoin(revoker, ON.revoker)
      .where(where(context, filter, filter.state))
      .orderBy(desc(publicLinks.createdAt), desc(publicLinks.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    const total = await this.count(runner, context, filter, filter.state);
    return { rows, total };
  }

  /** How many links each state chip holds, under the same kind, person and search filters. */
  async counts(
    runner: TenantQueryRunner,
    context: TenantContext,
    filter: ManagedLinkFilter,
  ): Promise<{ readonly active: number; readonly endingSoon: number; readonly ended: number }> {
    return {
      active: await this.count(runner, context, filter, 'active'),
      endingSoon: await this.count(runner, context, filter, 'ending_soon'),
      ended: await this.count(runner, context, filter, 'ended'),
    };
  }

  /** Everyone who issued one of the workspace's links, for the "Created by" filter. */
  async creators(
    runner: TenantQueryRunner,
    context: TenantContext,
    kinds: readonly string[],
  ): Promise<readonly { readonly id: string; readonly name: string }[]> {
    const rows = await tenantDrizzle(runner)
      .selectDistinct({ id: users.id, name: users.displayName })
      .from(publicLinks)
      .innerJoin(users, eq(users.id, publicLinks.createdByUserId))
      .where(
        and(
          eq(publicLinks.organizationId, context.organizationId),
          inArray(publicLinks.kind, [...kinds]),
        ),
      )
      .orderBy(users.displayName);
    return rows;
  }

  /** Move the end of one live link of a managed kind; false when it is not live (or not ours). */
  async setExpiry(
    runner: TenantQueryRunner,
    context: TenantContext,
    linkId: string,
    kinds: readonly string[],
    expiresAt: Date,
    now: Date,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(publicLinks)
      .set({ expiresAt })
      .where(
        and(
          eq(publicLinks.organizationId, context.organizationId),
          eq(publicLinks.id, linkId),
          inArray(publicLinks.kind, [...kinds]),
          live(now),
        ),
      );
    return result[0].affectedRows > 0;
  }

  private async count(
    runner: TenantQueryRunner,
    context: TenantContext,
    filter: ManagedLinkFilter,
    state: PublicLinkStateFilter,
  ): Promise<number> {
    const rows = await tenantDrizzle(runner)
      .select({ n: count() })
      .from(publicLinks)
      .leftJoin(deliverableVersions, ON.version)
      .leftJoin(deliverables, ON.deliverable)
      .leftJoin(quotes, ON.quote)
      .leftJoin(creator, ON.creator)
      .leftJoin(revoker, ON.revoker)
      .where(where(context, filter, state));
    return Number(rows[0]?.n ?? 0);
  }
}

/** The joins both the page and its counts read through — each on the link's own organization. */
const ON = {
  version: and(
    eq(deliverableVersions.organizationId, publicLinks.organizationId),
    eq(deliverableVersions.id, publicLinks.targetId),
    eq(publicLinks.targetType, 'deliverable_version'),
  ),
  deliverable: and(
    eq(deliverables.organizationId, deliverableVersions.organizationId),
    eq(deliverables.id, deliverableVersions.deliverableId),
  ),
  quote: and(
    eq(quotes.organizationId, publicLinks.organizationId),
    eq(quotes.id, publicLinks.targetId),
    eq(publicLinks.targetType, 'quote'),
  ),
  creator: eq(creator.id, publicLinks.createdByUserId),
  revoker: eq(revoker.id, publicLinks.revokedByUserId),
};
