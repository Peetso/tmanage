import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { meetingActionItems } from '../../common/database/schema.js';
import type { MeetingActionItemRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The meeting-action-items repository — CAL / MTG-03 (x266), following the `meeting_attendees`
 * (x126) pattern.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally, exactly as the
 * meetings and meeting-attendees repositories honour it:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner`
 *    for the current unit of work and the `TenantContext`. There is no overload without a context.
 * 2. **The tenant comes from the context, never the DTO.** {@link CreateActionItemInput} has no
 *    `organizationId` field, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, built with Drizzle and executed through the
 *    guard (`drizzle.ts`), so a forgotten predicate throws rather than leaking rows.
 *
 * The runner is a parameter, not a field: the repository holds no connection and no state.
 */

/**
 * Injection token for {@link MeetingActionItemsRepository}. Slice-local (declared beside the class
 * it provides) to keep this slice file-disjoint from the shared `common/http/tokens.ts` append
 * point, exactly as `MEETING_AGENDA_REPOSITORY` (x127) is.
 */
export const MEETING_ACTION_ITEMS_REPOSITORY = Symbol('MEETING_ACTION_ITEMS_REPOSITORY');

export type ActionItemStatus = 'open' | 'done';

/**
 * Note what is absent: `organizationId`. It is taken from the context, so there is no field for a
 * request body to populate. `meetingId` and any `ownerMembershipId` are resolved tenant-scoped by
 * the service before the write, and the composite foreign keys refuse a meeting or membership from
 * another tenant besides.
 */
export interface CreateActionItemInput {
  readonly meetingId: string;
  readonly title: string;
  readonly ownerMembershipId: string | null;
  readonly dueOn: string | null;
}

/** The mutable fields of an action item — what a PATCH may set. Absent fields are left untouched. */
export interface UpdateActionItemInput {
  readonly title?: string;
  readonly ownerMembershipId?: string | null;
  readonly dueOn?: string | null;
  readonly status?: ActionItemStatus;
}

export interface ListActionItemsOptions {
  /** Required: this slice lists one meeting's action items, never a whole tenant's. */
  readonly meetingId: string;
  /** Keyset pagination. Cursors are ids, and the sort is `id` (UUIDv7 ≈ creation order). */
  readonly after?: string;
  readonly limit?: number;
}

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;

export function effectivePageSize(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

export class MeetingActionItemsRepository {
  /**
   * List one meeting's action items, within the acting tenant.
   *
   * Both `organization_id` and `meeting_id` predicates are present. Keyset rather than offset
   * pagination on the action item `id`: `(organization_id, meeting_id, id)` is a key the schema
   * carries, and UUIDv7 ids sort in creation order so the ordering is deterministic.
   */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: ListActionItemsOptions,
  ): Promise<readonly MeetingActionItemRow[]> {
    const limit = effectivePageSize(options.limit);
    const db = tenantDrizzle(runner);

    const predicates = [
      eq(meetingActionItems.organizationId, context.organizationId),
      eq(meetingActionItems.meetingId, options.meetingId),
    ];
    if (options.after) predicates.push(gt(meetingActionItems.id, options.after));

    return db
      .select()
      .from(meetingActionItems)
      .where(and(...predicates))
      .orderBy(asc(meetingActionItems.id))
      .limit(limit);
  }

  /**
   * Fetch one action item by id, within the acting tenant.
   *
   * Used by the service to check an item belongs to the meeting named in the path before a write.
   * No `findById(id)` without a context: on MySQL that would return another customer's row.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    actionItemId: string,
  ): Promise<MeetingActionItemRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(meetingActionItems)
      .where(
        and(
          eq(meetingActionItems.organizationId, context.organizationId),
          eq(meetingActionItems.id, actionItemId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Create an action item on a meeting.
   *
   * The id is generated here (UUIDv7, `07-DATA-MODEL`). `organization_id` comes from the context,
   * never from `input`. The meeting and any owner are *not* re-checked to belong to the tenant here:
   * the service resolves both tenant-scoped before the write, and the composite foreign keys refuse
   * either from another tenant regardless. A new item starts `open` (the column default agrees).
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateActionItemInput,
  ): Promise<MeetingActionItemRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    await db.insert(meetingActionItems).values({
      id,
      // From the context. Not from `input` — there is no such field.
      organizationId: context.organizationId,
      meetingId: input.meetingId,
      title: input.title,
      ownerMembershipId: input.ownerMembershipId,
      dueOn: input.dueOn,
      status: 'open',
      createdAt: sql`current_timestamp(3)`,
      updatedAt: sql`current_timestamp(3)`,
    });

    const created = await this.findById(runner, context, id);
    if (!created) {
      // Unreachable: the row was just inserted in this transaction. A null here would be a torn write.
      throw new Error(`meeting_action_item ${id} was not found immediately after insert`);
    }
    return created;
  }

  /**
   * Update an action item's mutable fields, within the acting tenant and its meeting.
   *
   * The `WHERE` carries `organization_id`, `id` *and* `meeting_id`: an item that belongs to another
   * tenant or another meeting matches nothing and is left untouched (the service has already
   * resolved it scoped, so this is belt-and-braces). Only the fields present in `changes` are
   * written; the identity columns are immutable at the engine (0136's trigger) besides.
   */
  async update(
    runner: TenantQueryRunner,
    context: TenantContext,
    meetingId: string,
    actionItemId: string,
    changes: UpdateActionItemInput,
  ): Promise<MeetingActionItemRow> {
    const db = tenantDrizzle(runner);

    const set: Record<string, unknown> = { updatedAt: sql`current_timestamp(3)` };
    if (changes.title !== undefined) set['title'] = changes.title;
    if (changes.ownerMembershipId !== undefined)
      set['ownerMembershipId'] = changes.ownerMembershipId;
    if (changes.dueOn !== undefined) set['dueOn'] = changes.dueOn;
    if (changes.status !== undefined) set['status'] = changes.status;

    await db
      .update(meetingActionItems)
      .set(set)
      .where(
        and(
          eq(meetingActionItems.organizationId, context.organizationId),
          eq(meetingActionItems.meetingId, meetingId),
          eq(meetingActionItems.id, actionItemId),
        ),
      );

    const updated = await this.findById(runner, context, actionItemId);
    if (!updated) {
      // Unreachable: the service resolved the item scoped before calling this in the same
      // transaction. A null here would be a torn write.
      throw new Error(`meeting_action_item ${actionItemId} was not found immediately after update`);
    }
    return updated;
  }

  /**
   * Delete an action item, within the acting tenant and its meeting.
   *
   * The `WHERE` carries `organization_id`, `id` *and* `meeting_id`, so an item of another tenant or
   * meeting matches nothing and is left untouched. The service resolves the item scoped first.
   */
  async remove(
    runner: TenantQueryRunner,
    context: TenantContext,
    meetingId: string,
    actionItemId: string,
  ): Promise<void> {
    const db = tenantDrizzle(runner);
    await db
      .delete(meetingActionItems)
      .where(
        and(
          eq(meetingActionItems.organizationId, context.organizationId),
          eq(meetingActionItems.meetingId, meetingId),
          eq(meetingActionItems.id, actionItemId),
        ),
      );
  }
}
