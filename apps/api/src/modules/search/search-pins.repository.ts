import { and, asc, desc, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { searchPins } from '../../common/database/schema.js';
import type { SearchPinRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * SRCH quick-access pins (x290) — the data half. One stateless repository over `search_pins`.
 *
 * ## Every operation is scoped to one member in one studio
 *
 * A pin is private: the owner is the only reader and the only unpinner. So every method here carries
 * both `organization_id = context.organizationId` AND `membership_id = context.membershipId`
 * predicates — the tenant boundary and the owner boundary together. A cross-tenant id, or another
 * member's id, simply does not match, so a listing never returns it and an unpin removes nothing.
 * There is no UPDATE endpoint: a pin is created and removed. A repeat pin of the same
 * `(object_type, object_id)` is not a second row — the `uq_search_pins_member_target` unique key
 * turns the INSERT into an idempotent label refresh via `ON DUPLICATE KEY UPDATE`, which the INSERT
 * grant covers (no UPDATE privilege is granted or needed).
 */
export class SearchPinsRepository {
  /**
   * Pin one entity for the acting member, idempotently. A first pin inserts; a repeat of the same
   * `(objectType, objectId)` refreshes the stored `label` in place via the unique key rather than
   * adding a row. The id and tenant come from here.
   */
  async upsertPin(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: {
      readonly objectType: string;
      readonly objectId: string;
      readonly label: string;
    },
  ): Promise<SearchPinRow> {
    await tenantDrizzle(runner)
      .insert(searchPins)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        membershipId: context.membershipId,
        objectType: input.objectType,
        objectId: input.objectId,
        label: input.label,
        createdAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({ set: { label: input.label } });
    const row = await this.findOwnedByTarget(runner, context, input.objectType, input.objectId);
    if (!row) throw new Error('search_pins row vanished immediately after upsert');
    return row;
  }

  /** The acting member's pin of one target, tenant- and owner-scoped, or undefined. */
  async findOwnedByTarget(
    runner: TenantQueryRunner,
    context: TenantContext,
    objectType: string,
    objectId: string,
  ): Promise<SearchPinRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(searchPins)
      .where(
        and(
          eq(searchPins.organizationId, context.organizationId),
          eq(searchPins.membershipId, context.membershipId),
          eq(searchPins.objectType, objectType),
          eq(searchPins.objectId, objectId),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /** The acting member's pins, newest first with id breaking ties (a total order). */
  async listPins(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly SearchPinRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(searchPins)
      .where(
        and(
          eq(searchPins.organizationId, context.organizationId),
          eq(searchPins.membershipId, context.membershipId),
        ),
      )
      .orderBy(desc(searchPins.createdAt), asc(searchPins.id));
  }

  /**
   * Unpin the acting member's pin by id. Scoped by tenant and owner, so an id that names another
   * member's pin, another studio's pin, or nothing removes nothing — a caller can only ever remove
   * their own, and the unpin is idempotent (an absent pin is a no-op the service answers 204).
   */
  async deleteOwned(runner: TenantQueryRunner, context: TenantContext, id: string): Promise<void> {
    await tenantDrizzle(runner)
      .delete(searchPins)
      .where(
        and(
          eq(searchPins.organizationId, context.organizationId),
          eq(searchPins.membershipId, context.membershipId),
          eq(searchPins.id, id),
        ),
      );
  }
}
