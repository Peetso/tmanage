import { and, desc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { inboxSourceMutes } from '../../common/database/schema.js';
import type { InboxSourceMuteRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The inbox object-type prefixes a source mute can name — exactly the object types the inbox bundle
 * read composes (`inbox.service.ts`: `work_item`, `client_request`, and the owner/admin
 * `organization_usage` notice). The service validates a mute against this set before any write, so
 * an off-allowlist type is a 400 with no row and the read-side filter only ever compares like keys.
 */
export const INBOX_MUTE_OBJECT_TYPES = [
  'work_item',
  'client_request',
  'organization_usage',
] as const;
export type InboxMuteObjectType = (typeof INBOX_MUTE_OBJECT_TYPES)[number];

/**
 * x318's data half — a member's own muted inbox sources, and the read the inbox bundle composition
 * excludes muted sources against.
 *
 * ## The scope is the tenant boundary
 *
 * A mute names a source as `(object_type, object_id)` and carries no foreign key to the object (it
 * lives in a different table per prefix, and `organization_usage` names the organization itself), so
 * a mute's tenant safety is not an FK: it is that every method runs an `organization_id =
 * context.organizationId` predicate — a mute never crosses a tenant boundary, and because a mute is
 * only a self-scoped read-side filter, a source that does not exist or the caller cannot see is
 * harmless (it simply matches nothing to hide).
 *
 * ## Mutes are private to a member
 *
 * Every read, the insert and the delete are scoped by `member_user_id = context.userId`, so one
 * member never sees, adds or removes another's mutes even inside the same tenant. The write path is
 * INSERT (mute) and DELETE (un-mute) only — a row is never edited — so re-muting is resolved as an
 * idempotent no-op by {@link findOwn} before {@link insert}, never an UPDATE.
 */
export class InboxSourceMutesRepository {
  /** The member's existing mute of this source, if any — the idempotency probe. */
  async findOwn(
    runner: TenantQueryRunner,
    context: TenantContext,
    memberUserId: string,
    objectType: InboxMuteObjectType,
    objectId: string,
  ): Promise<InboxSourceMuteRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(inboxSourceMutes)
      .where(
        and(
          eq(inboxSourceMutes.organizationId, context.organizationId),
          eq(inboxSourceMutes.memberUserId, memberUserId),
          eq(inboxSourceMutes.objectType, objectType),
          eq(inboxSourceMutes.objectId, objectId),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /**
   * Insert one mute for the acting member. The id and tenant come from here, never from input. The
   * service calls this only after {@link findOwn} found nothing, so re-muting is an idempotent no-op
   * rather than a conflict against `uq_inbox_source_mutes_pin`.
   */
  async insert(
    runner: TenantQueryRunner,
    context: TenantContext,
    memberUserId: string,
    objectType: InboxMuteObjectType,
    objectId: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(inboxSourceMutes)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        memberUserId,
        objectType,
        objectId,
        createdAt: sql`current_timestamp(3)`,
      });
  }

  /**
   * Delete the caller's own mute of one source. Scoped by `member_user_id = the acting member`, so a
   * source another member muted (or one nobody muted) removes nothing — the un-mute is idempotent.
   * Returns whether a row was removed, for callers that care; the route answers 204 either way.
   */
  async deleteOwn(
    runner: TenantQueryRunner,
    context: TenantContext,
    memberUserId: string,
    objectType: InboxMuteObjectType,
    objectId: string,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .delete(inboxSourceMutes)
      .where(
        and(
          eq(inboxSourceMutes.organizationId, context.organizationId),
          eq(inboxSourceMutes.memberUserId, memberUserId),
          eq(inboxSourceMutes.objectType, objectType),
          eq(inboxSourceMutes.objectId, objectId),
        ),
      );
    return result[0].affectedRows > 0;
  }

  /**
   * Every mute the acting member holds in this tenant, newest first then id — the deterministic
   * order of `ix_inbox_source_mutes_org_member`. This is the read the inbox bundle composition can
   * call to exclude muted `(objectType, objectId)` sources from a member's inbox (an additive helper;
   * the inbox core is unchanged this slice).
   */
  async listForMember(
    runner: TenantQueryRunner,
    context: TenantContext,
    memberUserId: string,
  ): Promise<readonly InboxSourceMuteRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(inboxSourceMutes)
      .where(
        and(
          eq(inboxSourceMutes.organizationId, context.organizationId),
          eq(inboxSourceMutes.memberUserId, memberUserId),
        ),
      )
      .orderBy(desc(inboxSourceMutes.id));
  }
}
