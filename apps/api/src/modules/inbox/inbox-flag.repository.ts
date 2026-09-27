import { and, desc, eq } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { inboxFlags, notifications } from '../../common/database/schema.js';
import type { InboxFlagRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * INBOX-001 IN-01 "Important inbox" (x260) — a membership's private "important" flags over inbox
 * bundles, and the recipient-scoped ownership read that gates a flag write.
 *
 * It follows the `doc_bookmarks` / `home_pinned_items` repository shape and honours `25-AUTH` §6
 * structurally:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner` and
 *    the `TenantContext`, and every statement carries the tenant predicate.
 * 2. **The subject is the acting membership, never a DTO field** — the flag list and the unflag are
 *    scoped by `membershipId`, so one member never sees or removes another's flags.
 * 3. **A flag is created and removed, never edited** — INSERT and DELETE only, no UPDATE path and no
 *    UPDATE grant, so the withheld privilege is the control (no immutability trigger needed).
 *
 * The runner is a parameter, not a field: the service composes the ownership check and the insert on
 * connections `TenantDatabase.read()` / `.transaction()` own.
 */

/** A membership's flags list is bounded — a long "Important" view must not be unbounded. */
const MAX_FLAGS_LISTED = 200;

export class InboxFlagRepository {
  /**
   * Whether the caller has any notification row about this object — the recipient-only ownership gate
   * NOTIF-001 enforces, read the way {@link ../inbox/notifications.repository.ts} reads its rows.
   *
   * A bundle is `objectType:objectId`; a member owns it iff a notification addressed to them
   * (`recipient_user_id`) about that object exists in this tenant. Another member's bundle has no such
   * row for the caller, so the service refuses the flag with a 404 before any insert.
   */
  async hasNotificationForRecipient(
    runner: TenantQueryRunner,
    context: TenantContext,
    recipientUserId: string,
    objectType: string,
    objectId: string,
  ): Promise<boolean> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.organizationId, context.organizationId),
          eq(notifications.recipientUserId, recipientUserId),
          eq(notifications.objectType, objectType),
          eq(notifications.objectId, objectId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** Fetch one membership's flag of one bundle, scoped to the acting tenant, or null. */
  async find(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    bundleId: string,
  ): Promise<InboxFlagRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(inboxFlags)
      .where(
        and(
          eq(inboxFlags.organizationId, context.organizationId),
          eq(inboxFlags.membershipId, membershipId),
          eq(inboxFlags.bundleId, bundleId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Flag a bundle for a membership, idempotently. If the flag already exists it is returned unchanged
   * (a repeated PUT is a no-op, never a second row and never an UPDATE — the grant withholds UPDATE);
   * otherwise a new row is inserted. The `(organization_id, membership_id, bundle_id)` unique key is the
   * guard: a racing insert that collides is caught and the existing row re-read.
   */
  async add(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    bundleId: string,
  ): Promise<InboxFlagRow> {
    const existing = await this.find(runner, context, membershipId, bundleId);
    if (existing) {
      return existing;
    }

    const db = tenantDrizzle(runner);
    try {
      await db.insert(inboxFlags).values({
        id: uuidv7(),
        organizationId: context.organizationId,
        membershipId,
        bundleId,
        createdAt: new Date(),
      });
    } catch (error) {
      // A concurrent PUT won the unique key first; the flag now exists, so re-read it and treat this
      // call as the idempotent no-op it is. Any other error is a real failure — rethrow.
      const raced = await this.find(runner, context, membershipId, bundleId);
      if (raced) {
        return raced;
      }
      throw error;
    }

    const inserted = await this.find(runner, context, membershipId, bundleId);
    return inserted as InboxFlagRow;
  }

  /** Remove a membership's flag of a bundle, scoped to the acting tenant. Idempotent (no row → no-op). */
  async remove(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    bundleId: string,
  ): Promise<void> {
    const db = tenantDrizzle(runner);
    await db
      .delete(inboxFlags)
      .where(
        and(
          eq(inboxFlags.organizationId, context.organizationId),
          eq(inboxFlags.membershipId, membershipId),
          eq(inboxFlags.bundleId, bundleId),
        ),
      );
  }

  /**
   * One membership's flagged bundle ids, newest first — the "Important" view, projected to the caller's
   * own rows and nothing else. Bounded by {@link MAX_FLAGS_LISTED}.
   */
  async listForMembership(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<readonly string[]> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select({ bundleId: inboxFlags.bundleId })
      .from(inboxFlags)
      .where(
        and(
          eq(inboxFlags.organizationId, context.organizationId),
          eq(inboxFlags.membershipId, membershipId),
        ),
      )
      .orderBy(desc(inboxFlags.createdAt), desc(inboxFlags.id))
      .limit(MAX_FLAGS_LISTED);
    return rows.map((row) => row.bundleId);
  }
}
