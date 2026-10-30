import { and, count, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import type { RowDataPacket } from 'mysql2';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  organizations,
  publicLinkCodes,
  publicLinkEvents,
  publicLinks,
} from '../../common/database/schema.js';
import type { PublicLinkCodeRow, PublicLinkRow } from '../../common/database/schema.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';

/**
 * 56-07 — the one file holding a driver handle for `public_links`, `public_link_events` and
 * `public_link_codes` (0257, TENANT).
 *
 * Every read and write is bound to `context.organizationId` — the member's, or the service
 * context the outsider path builds for the link's organization. The single exception is
 * {@link findLinkByTokenHash}: an outsider has no session, so the token hash is looked up on
 * `bootstrapRead` with `public_links` as its only table, and it returns the link's id and
 * organization only, so everything else is re-read inside that organization's scope.
 */

export const MAX_LISTED_LINKS = 200;

export type NewPublicLink = Omit<
  PublicLinkRow,
  'uses' | 'decision' | 'decidedAt' | 'revokedAt' | 'revokedByUserId' | 'lastOpenedAt'
>;

export interface NewPublicLinkEvent {
  readonly id: string;
  readonly linkId: string;
  readonly kind: string;
  readonly detail: string | null;
  readonly ipHash: string | null;
  readonly userAgent: string | null;
  readonly createdAt: Date;
}

/** The outsider's first step: which link, of which organization, a token hash names. */
export async function findLinkByTokenHash(
  database: TenantDatabase,
  tokenHash: string,
  correlationId: string,
): Promise<{ readonly id: string; readonly organizationId: string } | null> {
  const rows = await database.bootstrapRead(
    {
      correlationId,
      reason:
        'a public link has no session: finding the one link a presented token names, by its ' +
        'peppered hash, to learn the organization every further read is scoped to',
      tables: ['public_links'],
    },
    (runner) =>
      runner.query<RowDataPacket[]>(
        'select id, organization_id from public_links where token_hash = ? limit 1',
        [tokenHash],
      ),
  );
  const row = rows[0];
  return row ? { id: String(row['id']), organizationId: String(row['organization_id']) } : null;
}

export class PublicLinksRepository {
  async insert(runner: TenantQueryRunner, context: TenantContext, link: NewPublicLink) {
    await tenantDrizzle(runner)
      .insert(publicLinks)
      .values({ ...link, organizationId: context.organizationId });
  }

  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    linkId: string,
    lock = false,
  ): Promise<PublicLinkRow | null> {
    const query = tenantDrizzle(runner)
      .select()
      .from(publicLinks)
      .where(
        and(eq(publicLinks.organizationId, context.organizationId), eq(publicLinks.id, linkId)),
      )
      .limit(1);
    const rows = lock ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    target: { readonly targetType: string; readonly targetId: string } | null,
  ): Promise<readonly PublicLinkRow[]> {
    const scope = eq(publicLinks.organizationId, context.organizationId);
    return tenantDrizzle(runner)
      .select()
      .from(publicLinks)
      .where(
        target === null
          ? scope
          : and(
              scope,
              eq(publicLinks.targetType, target.targetType),
              eq(publicLinks.targetId, target.targetId),
            ),
      )
      .orderBy(desc(publicLinks.createdAt), desc(publicLinks.id))
      .limit(MAX_LISTED_LINKS);
  }

  /** Revoke a live link; false when it was already revoked or decided. */
  async revoke(
    runner: TenantQueryRunner,
    context: TenantContext,
    linkId: string,
    at: Date,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(publicLinks)
      .set({ revokedAt: at, revokedByUserId: context.userId })
      .where(
        and(
          eq(publicLinks.organizationId, context.organizationId),
          eq(publicLinks.id, linkId),
          isNull(publicLinks.revokedAt),
          isNull(publicLinks.decision),
        ),
      );
    return result[0].affectedRows > 0;
  }

  async recordOpen(runner: TenantQueryRunner, context: TenantContext, linkId: string, at: Date) {
    await tenantDrizzle(runner)
      .update(publicLinks)
      .set({ uses: sql`${publicLinks.uses} + 1`, lastOpenedAt: at })
      .where(
        and(eq(publicLinks.organizationId, context.organizationId), eq(publicLinks.id, linkId)),
      );
  }

  /** The one terminal decision: true only for the call that made it. */
  async decide(
    runner: TenantQueryRunner,
    context: TenantContext,
    linkId: string,
    decision: string,
    at: Date,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(publicLinks)
      .set({ decision, decidedAt: at })
      .where(
        and(
          eq(publicLinks.organizationId, context.organizationId),
          eq(publicLinks.id, linkId),
          isNull(publicLinks.decision),
          isNull(publicLinks.revokedAt),
        ),
      );
    return result[0].affectedRows > 0;
  }

  async appendEvent(runner: TenantQueryRunner, context: TenantContext, event: NewPublicLinkEvent) {
    await tenantDrizzle(runner)
      .insert(publicLinkEvents)
      .values({ ...event, organizationId: context.organizationId });
  }

  async countEventsSince(
    runner: TenantQueryRunner,
    context: TenantContext,
    linkId: string,
    kind: string,
    since: Date,
  ): Promise<number> {
    const rows = await tenantDrizzle(runner)
      .select({ n: count() })
      .from(publicLinkEvents)
      .where(
        and(
          eq(publicLinkEvents.organizationId, context.organizationId),
          eq(publicLinkEvents.linkId, linkId),
          eq(publicLinkEvents.kind, kind),
          gte(publicLinkEvents.createdAt, since),
        ),
      );
    return Number(rows[0]?.n ?? 0);
  }

  /** Issue (or replace on resend) the link's live code: attempts start again at zero. */
  async putCode(
    runner: TenantQueryRunner,
    context: TenantContext,
    code: { readonly linkId: string; readonly codeHash: string; expiresAt: Date; createdAt: Date },
  ) {
    await tenantDrizzle(runner)
      .insert(publicLinkCodes)
      .values({ ...code, organizationId: context.organizationId, attempts: 0 })
      .onDuplicateKeyUpdate({
        set: {
          codeHash: code.codeHash,
          expiresAt: code.expiresAt,
          createdAt: code.createdAt,
          attempts: 0,
        },
      });
  }

  async findCode(
    runner: TenantQueryRunner,
    context: TenantContext,
    linkId: string,
  ): Promise<PublicLinkCodeRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(publicLinkCodes)
      .where(this.codeScope(context, linkId))
      .limit(1)
      .for('update');
    return rows[0] ?? null;
  }

  async countCodeAttempt(runner: TenantQueryRunner, context: TenantContext, linkId: string) {
    await tenantDrizzle(runner)
      .update(publicLinkCodes)
      .set({ attempts: sql`${publicLinkCodes.attempts} + 1` })
      .where(this.codeScope(context, linkId));
  }

  async deleteCode(runner: TenantQueryRunner, context: TenantContext, linkId: string) {
    await tenantDrizzle(runner).delete(publicLinkCodes).where(this.codeScope(context, linkId));
  }

  async organizationName(runner: TenantQueryRunner, context: TenantContext): Promise<string> {
    const rows = await tenantDrizzle(runner)
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, context.organizationId))
      .limit(1);
    return rows[0]?.name ?? '';
  }

  private codeScope(context: TenantContext, linkId: string) {
    return and(
      eq(publicLinkCodes.organizationId, context.organizationId),
      eq(publicLinkCodes.linkId, linkId),
    );
  }
}
