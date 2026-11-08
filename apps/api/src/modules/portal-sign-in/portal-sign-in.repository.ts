import { and, count, desc, eq, gt, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { RowDataPacket } from 'mysql2';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { authenticationEvents, organizations, publicLinks } from '../../common/database/schema.js';
import { createServiceContext } from '../../common/database/tenant-context.js';
import type {
  BootstrapQueryRunner,
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { orderedUuidv7 } from '../identity/ordered-id.js';
import type { PublicLinkSecrets } from '../public-links/public-link-secrets.js';
import {
  PublicLinksRepository,
  findLinkByTokenHash,
} from '../public-links/public-links.repository.js';
import {
  FAILED_OPEN_REASONS,
  MAGIC_LINK_ACTION,
  MAGIC_SIGNIN_TARGET,
  type EligibleClient,
  type OutsiderMeta,
  type PortalSignInStore,
  type PortalSignInTx,
} from './portal-sign-in.service.js';

/**
 * 55-14 — the driver side of {@link PortalSignInStore}.
 *
 * The outsider has no session, so two reads run on `bootstrapRead` (declared tables, a stated
 * reason): the organization a slug names, and whether an address is an eligible client there.
 * Every link read and write then runs in a SERVICE context for that one organization, through
 * `PublicLinksRepository` (56-07) plus the four magic-link-only queries below. The sign-in trail
 * goes to `authentication_events` on an identity transaction of its own, like every sign-in.
 */

const BOOTSTRAP_REASON =
  'client portal magic-link sign-in has no session: resolving the organization a slug names ' +
  'and whether a typed e-mail is an active client of it, before any tenant scope exists';
const MAX_EVENT_TEXT = 255;

export class PortalSignInRepository implements PortalSignInStore {
  private readonly links = new PublicLinksRepository();

  constructor(
    private readonly database: TenantDatabase,
    private readonly secrets: PublicLinkSecrets,
  ) {}

  async findOrganization(slug: string, correlationId: string) {
    const rows = await this.database.bootstrapRead(
      { correlationId, reason: BOOTSTRAP_REASON, tables: ['organizations'] },
      (runner) =>
        runner.query<RowDataPacket[]>('select id from organizations where slug = ? limit 1', [
          slug,
        ]),
    );
    const row = rows[0];
    return row ? { id: String(row['id']) } : null;
  }

  async findEligibleClient(organizationId: string, email: string, correlationId: string) {
    return this.eligible(organizationId, { email }, correlationId);
  }

  async stillEligible(
    organizationId: string,
    membershipId: string,
    email: string,
    correlationId: string,
  ) {
    return this.eligible(organizationId, { email, membershipId }, correlationId);
  }

  findLinkByHash(hash: string, correlationId: string) {
    return findLinkByTokenHash(this.database, hash, correlationId);
  }

  transaction<T>(
    organizationId: string,
    correlationId: string,
    work: (tx: PortalSignInTx) => Promise<T>,
  ): Promise<T> {
    const context = createServiceContext({
      organizationId,
      correlationId,
      policyVersion: 'portal-sign-in',
    });
    return this.database.transaction(context, (runner) => work(this.tx(runner, context)));
  }

  async recordAuthEvent(event: {
    readonly userId: string | null;
    readonly outcome: 'succeeded' | 'failed';
    readonly reason: string | null;
    readonly meta: OutsiderMeta;
    readonly correlationId: string;
  }): Promise<void> {
    await this.database.identityTransaction(
      { correlationId: event.correlationId, tables: ['authentication_events'] },
      (tx) =>
        tenantDrizzle(tx)
          .insert(authenticationEvents)
          .values({
            id: orderedUuidv7(),
            userId: event.userId,
            action: MAGIC_LINK_ACTION,
            outcome: event.outcome,
            reason: event.reason,
            ip: event.meta.ip?.slice(0, 45) ?? null,
            userAgent: event.meta.userAgent?.slice(0, MAX_EVENT_TEXT) ?? null,
            correlationId: event.correlationId,
            occurredAt: sql`current_timestamp(3)`,
          }),
    );
  }

  async countFailedOpens(userId: string, since: Date, correlationId: string): Promise<number> {
    const rows = await this.database.identityRead(
      { correlationId, tables: ['authentication_events'] },
      (tx) =>
        tenantDrizzle(tx)
          .select({ n: count() })
          .from(authenticationEvents)
          .where(
            and(
              eq(authenticationEvents.userId, userId),
              eq(authenticationEvents.action, MAGIC_LINK_ACTION),
              eq(authenticationEvents.outcome, 'failed'),
              inArray(authenticationEvents.reason, [...FAILED_OPEN_REASONS]),
              gte(authenticationEvents.occurredAt, since),
            ),
          ),
    );
    return Number(rows[0]?.n ?? 0);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * Eligible = an active, unexpired client membership of this organization whose user holds
   * the address, is not disabled, has no internal membership anywhere and no second factor.
   * A magic link must never be a way round a staff member's password or two-step sign-in.
   */
  private async eligible(
    organizationId: string,
    match: { readonly email: string; readonly membershipId?: string },
    correlationId: string,
  ): Promise<EligibleClient | null> {
    if (match.email === '') return null;
    return this.database.bootstrapRead(
      {
        correlationId,
        reason: BOOTSTRAP_REASON,
        tables: ['client_memberships', 'memberships'],
      },
      async (runner) => {
        const clients = await runner.query<RowDataPacket[]>(
          'select cm.id as membership_id, u.id as user_id, u.email as email ' +
            'from client_memberships cm join users u on u.id = cm.user_id ' +
            'where cm.organization_id = ? and lower(u.email) = ? and cm.status = ? ' +
            'and (cm.expires_at is null or cm.expires_at > current_timestamp(3)) ' +
            'and u.disabled_at is null' +
            (match.membershipId === undefined ? '' : ' and cm.id = ?') +
            ' order by cm.created_at, cm.id limit 1',
          match.membershipId === undefined
            ? [organizationId, match.email.toLowerCase(), 'active']
            : [organizationId, match.email.toLowerCase(), 'active', match.membershipId],
        );
        const row = clients[0];
        if (!row) return null;
        const userId = String(row['user_id']);
        if (await this.hasStaffAccessOrSecondFactor(runner, userId)) return null;
        return {
          userId,
          membershipId: String(row['membership_id']),
          email: String(row['email']).toLowerCase(),
        };
      },
    );
  }

  private async hasStaffAccessOrSecondFactor(
    runner: BootstrapQueryRunner,
    userId: string,
  ): Promise<boolean> {
    const staff = await runner.query<RowDataPacket[]>(
      'select id from memberships where user_id = ? and status <> ? limit 1',
      [userId, 'offboarded'],
    );
    if (staff.length > 0) return true;
    const factors = await runner.query<RowDataPacket[]>(
      'select id from user_mfa_factors where user_id = ? and disabled_at is null limit 1',
      [userId],
    );
    return factors.length > 0;
  }

  private tx(runner: TenantQueryRunner, context: TenantContext): PortalSignInTx {
    const links = this.links;
    const scope = eq(publicLinks.organizationId, context.organizationId);
    const ofMembership = (membershipId: string) =>
      and(
        scope,
        eq(publicLinks.kind, 'magic_signin'),
        eq(publicLinks.targetType, MAGIC_SIGNIN_TARGET),
        eq(publicLinks.targetId, membershipId),
      );
    const unrevoked = (linkId: string) =>
      and(scope, eq(publicLinks.id, linkId), isNull(publicLinks.revokedAt));
    return {
      findLink: (linkId) => links.findById(runner, context, linkId, true),
      insertLink: (row) => links.insert(runner, context, row),
      revokeLiveFor: async (membershipId, at) => {
        const result = await tenantDrizzle(runner)
          .update(publicLinks)
          .set({ revokedAt: at, revokedByUserId: null })
          .where(
            and(
              ofMembership(membershipId),
              isNull(publicLinks.revokedAt),
              gt(publicLinks.expiresAt, at),
              lt(publicLinks.uses, sql`coalesce(${publicLinks.maxUses}, 1)`),
            ),
          );
        return result[0].affectedRows;
      },
      revoke: async (linkId, at) => {
        const result = await tenantDrizzle(runner)
          .update(publicLinks)
          .set({ revokedAt: at, revokedByUserId: null })
          .where(unrevoked(linkId));
        return result[0].affectedRows > 0;
      },
      recordOpen: (linkId, at) => links.recordOpen(runner, context, linkId, at),
      countIssuedSince: async (membershipId, since) => {
        const rows = await tenantDrizzle(runner)
          .select({ n: count() })
          .from(publicLinks)
          .where(and(ofMembership(membershipId), gte(publicLinks.createdAt, since)));
        return Number(rows[0]?.n ?? 0);
      },
      newestLiveFor: async (membershipId, at) => {
        const rows = await tenantDrizzle(runner)
          .select()
          .from(publicLinks)
          .where(
            and(
              ofMembership(membershipId),
              isNull(publicLinks.revokedAt),
              gt(publicLinks.expiresAt, at),
              or(isNull(publicLinks.maxUses), lt(publicLinks.uses, publicLinks.maxUses)),
            ),
          )
          .orderBy(desc(publicLinks.createdAt), desc(publicLinks.id))
          .limit(1)
          .for('update');
        return rows[0] ?? null;
      },
      appendEvent: (linkId, kind, detail, meta) =>
        links.appendEvent(runner, context, {
          id: uuidv7(),
          linkId,
          kind,
          detail,
          ipHash: this.secrets.ipHash(meta.ip),
          userAgent: meta.userAgent?.slice(0, MAX_EVENT_TEXT) ?? null,
          createdAt: new Date(),
        }),
      putCode: (linkId, codeHash, expiresAt, at) =>
        links.putCode(runner, context, { linkId, codeHash, expiresAt, createdAt: at }),
      findCode: (linkId) => links.findCode(runner, context, linkId),
      countCodeAttempt: (linkId) => links.countCodeAttempt(runner, context, linkId),
      deleteCode: (linkId) => links.deleteCode(runner, context, linkId),
      organizationName: () => links.organizationName(runner, context),
      organizationSlug: async () => {
        const rows = await tenantDrizzle(runner)
          .select({ slug: organizations.slug })
          .from(organizations)
          .where(eq(organizations.id, context.organizationId))
          .limit(1);
        return rows[0]?.slug ?? '';
      },
    };
  }
}
