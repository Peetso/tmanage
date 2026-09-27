import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { meetingRsvps } from '../../common/database/schema.js';
import type { MeetingRsvpRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The meeting-RSVP repository — CAL meeting RSVP (x240), following the `meeting_attendees` (x126)
 * pattern.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally, exactly as the
 * meetings and meeting-attendees repositories honour it:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner`
 *    for the current unit of work and the `TenantContext`. There is no overload without a context,
 *    so a caller that never established a tenant is a type error.
 * 2. **The tenant comes from the context, never the DTO.** {@link UpsertRsvpInput} has no
 *    `organizationId` field, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, built with Drizzle and executed through the
 *    guard (`drizzle.ts`), so a forgotten predicate throws rather than leaking rows.
 *
 * The runner is a parameter, not a field: the repository holds no connection and no state.
 */

export const MEETING_RSVP_REPOSITORY = Symbol('MEETING_RSVP_REPOSITORY');

/** The three answers a member can give. */
export type MeetingRsvpResponse = 'accepted' | 'declined' | 'tentative';

/**
 * Note what is absent: `organizationId`. It is taken from the context, so there is no field for a
 * request body to populate and no code path that could prefer one over the other. `meetingId` is
 * resolved tenant-scoped by the service before the write, `memberId` is always the caller's own
 * membership, and the composite foreign keys refuse a meeting or membership from another tenant.
 */
export interface UpsertRsvpInput {
  readonly meetingId: string;
  /** The responding member — always the caller's own membership id. */
  readonly memberId: string;
  readonly response: MeetingRsvpResponse;
}

/** The response counts for a meeting, one per value of the vocabulary. */
export interface MeetingRsvpCounts {
  readonly accepted: number;
  readonly declined: number;
  readonly tentative: number;
}

export class MeetingRsvpRepository {
  /**
   * Fetch a meeting's response row for one member, within the acting tenant.
   *
   * The `(organization_id, meeting_id, member_id)` unique key backs this read: the service uses it
   * to decide between an INSERT (first answer) and an UPDATE (re-answer), so the PUT is idempotent
   * rather than a duplicate-key 500. It is also the caller's own response for the GET summary.
   */
  async findByMember(
    runner: TenantQueryRunner,
    context: TenantContext,
    meetingId: string,
    memberId: string,
  ): Promise<MeetingRsvpRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(meetingRsvps)
      .where(
        and(
          eq(meetingRsvps.organizationId, context.organizationId),
          eq(meetingRsvps.meetingId, meetingId),
          eq(meetingRsvps.memberId, memberId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Count a meeting's responses by value, within the acting tenant.
   *
   * Both `organization_id` and `meeting_id` predicates are present, and the grouping is by
   * `response`, so the whole summary is one scoped read. A value nobody chose is absent from the
   * grouped rows and reported as `0` — the vocabulary is fixed, so the shape is always complete.
   */
  async countsByResponse(
    runner: TenantQueryRunner,
    context: TenantContext,
    meetingId: string,
  ): Promise<MeetingRsvpCounts> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select({ response: meetingRsvps.response, count: sql<number>`count(*)` })
      .from(meetingRsvps)
      .where(
        and(
          eq(meetingRsvps.organizationId, context.organizationId),
          eq(meetingRsvps.meetingId, meetingId),
        ),
      )
      .groupBy(meetingRsvps.response);

    const counts: { accepted: number; declined: number; tentative: number } = {
      accepted: 0,
      declined: 0,
      tentative: 0,
    };
    for (const row of rows) {
      counts[row.response] = Number(row.count);
    }
    return counts;
  }

  /**
   * Record a member's first response.
   *
   * The id is generated here (UUIDv7, `07-DATA-MODEL`). `organization_id` comes from the context,
   * never from `input`. The meeting and membership are *not* re-checked to belong to the tenant
   * here: the service resolves the meeting tenant-scoped before the write, the `memberId` is the
   * caller's own membership from the principal, and the composite foreign keys refuse either from
   * another tenant regardless.
   */
  async insert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: UpsertRsvpInput,
  ): Promise<MeetingRsvpRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    await db.insert(meetingRsvps).values({
      id,
      // From the context. Not from `input` — there is no such field.
      organizationId: context.organizationId,
      meetingId: input.meetingId,
      memberId: input.memberId,
      response: input.response,
      createdAt: sql`current_timestamp(3)`,
      updatedAt: sql`current_timestamp(3)`,
    });

    const created = await this.findByMember(runner, context, input.meetingId, input.memberId);
    if (!created) {
      // Unreachable: the row was just inserted in this transaction. A null here would be a torn write.
      throw new Error(`meeting_rsvp for member ${input.memberId} was not found after insert`);
    }
    return created;
  }

  /**
   * Re-answer: update a member's existing response in place, within the acting tenant and meeting.
   *
   * The `WHERE` carries `organization_id`, `meeting_id` *and* `member_id`: a row from another tenant,
   * meeting or member matches nothing and is left untouched. Only `response` is written; the
   * identity columns are immutable at the engine (0112's trigger) besides, and `updated_at` advances
   * via its `ON UPDATE` clause.
   */
  async updateResponse(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: UpsertRsvpInput,
  ): Promise<MeetingRsvpRow> {
    const db = tenantDrizzle(runner);
    await db
      .update(meetingRsvps)
      .set({ response: input.response })
      .where(
        and(
          eq(meetingRsvps.organizationId, context.organizationId),
          eq(meetingRsvps.meetingId, input.meetingId),
          eq(meetingRsvps.memberId, input.memberId),
        ),
      );

    const updated = await this.findByMember(runner, context, input.meetingId, input.memberId);
    if (!updated) {
      // Unreachable: the service resolved the row before calling this in the same transaction.
      throw new Error(`meeting_rsvp for member ${input.memberId} was not found after update`);
    }
    return updated;
  }
}
