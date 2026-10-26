import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { meetingAttendees, memberships } from '../../common/database/schema.js';
import type { MeetingAttendeeRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The meeting-attendees repository — CAL-01 / MTG-01 attendees + RSVP (x126), following the
 * `meeting_notes` (x105) pattern.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally, exactly as the
 * meetings and meeting-notes repositories honour it:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the
 *    `TenantQueryRunner` for the current unit of work and the `TenantContext`. There is no
 *    overload without a context, so a caller that never established a tenant is a type error.
 * 2. **The tenant comes from the context, never the DTO.** {@link InviteAttendeeInput} has no
 *    `organizationId` field, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, built with Drizzle and executed through
 *    the guard (`drizzle.ts`), so a forgotten predicate throws rather than leaking rows.
 *
 * The runner is a parameter, not a field: the repository holds no connection and no state.
 */

export type AttendeeRsvp = 'invited' | 'accepted' | 'declined';

/**
 * 0237. What the column may hold: `tentative` arrives from Google ("maybe") and Outlook. The roster
 * views keep the three-value wire vocabulary until the meeting screens are redesigned (slice C);
 * {@link rosterRsvp} shows a tentative answer there as not yet answered, and the meeting overview
 * carries the real value.
 */
export type StoredAttendeeRsvp = AttendeeRsvp | 'tentative';

export function rosterRsvp(stored: StoredAttendeeRsvp): AttendeeRsvp {
  return stored === 'tentative' ? 'invited' : stored;
}

/**
 * An attendee joined to the member's `user_id` — what a read returns. The stored identity is the
 * `membership_id` (the composite FK to `memberships`), but the wire identity the rest of the app
 * uses is the `user_id`, so the read projects it. The member directory hides `membership_id`
 * deliberately (it is its keyset cursor), so this read does not surface it either.
 */
export interface AttendeeWithUser {
  readonly id: string;
  readonly meetingId: string;
  readonly userId: string;
  readonly rsvp: StoredAttendeeRsvp;
  readonly createdAt: Date;
}

/**
 * Note what is absent: `organizationId`. It is taken from the context, so there is no field for
 * a request body to populate and no code path that could prefer one over the other. `meetingId`
 * and `membershipId` are resolved tenant-scoped by the service before the write, and the composite
 * foreign keys refuse a meeting or membership from another tenant besides.
 */
export interface InviteAttendeeInput {
  readonly meetingId: string;
  readonly membershipId: string;
  /** A new attendee starts `invited`; the column default agrees. */
  readonly rsvp: AttendeeRsvp;
}

export interface ListAttendeesOptions {
  /** Required: this slice lists one meeting's attendees, never a whole tenant's. */
  readonly meetingId: string;
  /** Keyset pagination. Cursors are ids, and the sort is `id` (UUIDv7 ≈ creation order). */
  readonly after?: string;
  readonly limit?: number;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export function effectivePageSize(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

export class MeetingAttendeesRepository {
  /**
   * List one meeting's attendees, within the acting tenant, projected to the member's `user_id`.
   *
   * Both `organization_id` and `meeting_id` predicates are present, and the join to `memberships`
   * is anchored on `(organization_id, membership_id)` so it can never cross a tenant. Keyset rather
   * than offset pagination on the attendee `id`: `(organization_id, meeting_id, id)` is a key the
   * schema carries, and UUIDv7 ids sort in creation order so the ordering is deterministic without
   * a second sort column.
   */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: ListAttendeesOptions,
  ): Promise<readonly AttendeeWithUser[]> {
    const limit = effectivePageSize(options.limit);
    const db = tenantDrizzle(runner);

    const predicates = [
      eq(meetingAttendees.organizationId, context.organizationId),
      eq(meetingAttendees.meetingId, options.meetingId),
    ];
    if (options.after) predicates.push(gt(meetingAttendees.id, options.after));

    return db
      .select({
        id: meetingAttendees.id,
        meetingId: meetingAttendees.meetingId,
        userId: memberships.userId,
        rsvp: meetingAttendees.rsvp,
        createdAt: meetingAttendees.createdAt,
      })
      .from(meetingAttendees)
      .innerJoin(
        memberships,
        and(
          eq(memberships.organizationId, meetingAttendees.organizationId),
          eq(memberships.id, meetingAttendees.membershipId),
        ),
      )
      .where(and(...predicates))
      .orderBy(asc(meetingAttendees.id))
      .limit(limit);
  }

  /**
   * Fetch one attendee by id, within the acting tenant (the raw row, with its `membershipId`).
   *
   * Used by the service to check an attendee belongs to the meeting named in the path before a
   * write. No `findById(id)` without a context: on MySQL that would return another customer's row.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    attendeeId: string,
  ): Promise<MeetingAttendeeRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(meetingAttendees)
      .where(
        and(
          eq(meetingAttendees.organizationId, context.organizationId),
          eq(meetingAttendees.id, attendeeId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Fetch one attendee by id joined to the member's `user_id` — the read-back after a write.
   */
  async findWithUser(
    runner: TenantQueryRunner,
    context: TenantContext,
    attendeeId: string,
  ): Promise<AttendeeWithUser | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select({
        id: meetingAttendees.id,
        meetingId: meetingAttendees.meetingId,
        userId: memberships.userId,
        rsvp: meetingAttendees.rsvp,
        createdAt: meetingAttendees.createdAt,
      })
      .from(meetingAttendees)
      .innerJoin(
        memberships,
        and(
          eq(memberships.organizationId, meetingAttendees.organizationId),
          eq(memberships.id, meetingAttendees.membershipId),
        ),
      )
      .where(
        and(
          eq(meetingAttendees.organizationId, context.organizationId),
          eq(meetingAttendees.id, attendeeId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Fetch a meeting's attendee row for one membership, within the acting tenant.
   *
   * The `(organization_id, meeting_id, membership_id)` unique key backs this read: the service
   * uses it to turn a duplicate invite into a 409 rather than driving it into a duplicate-key 500.
   */
  async findByMembership(
    runner: TenantQueryRunner,
    context: TenantContext,
    meetingId: string,
    membershipId: string,
  ): Promise<MeetingAttendeeRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(meetingAttendees)
      .where(
        and(
          eq(meetingAttendees.organizationId, context.organizationId),
          eq(meetingAttendees.meetingId, meetingId),
          eq(meetingAttendees.membershipId, membershipId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Invite a member to a meeting.
   *
   * The id is generated here (UUIDv7, `07-DATA-MODEL`). `organization_id` comes from the context,
   * never from `input`. The meeting and membership are *not* re-checked to belong to the tenant
   * here: the service resolves both tenant-scoped before the write, and the composite foreign keys
   * `fk_meeting_attendees_meeting_tenant` / `fk_meeting_attendees_membership_tenant` refuse either
   * from another tenant regardless.
   */
  async invite(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: InviteAttendeeInput,
  ): Promise<AttendeeWithUser> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    await db.insert(meetingAttendees).values({
      id,
      // From the context. Not from `input` — there is no such field.
      organizationId: context.organizationId,
      meetingId: input.meetingId,
      membershipId: input.membershipId,
      rsvp: input.rsvp,
      createdAt: sql`current_timestamp(3)`,
    });

    const created = await this.findWithUser(runner, context, id);
    if (!created) {
      // Unreachable: the row was just inserted in this transaction against a membership the service
      // already resolved, so the inner join finds it. A null here would be a torn write.
      throw new Error(`meeting_attendee ${id} was not found immediately after insert`);
    }
    return created;
  }

  /**
   * Set an attendee's RSVP, within the acting tenant and its meeting.
   *
   * The `WHERE` carries `organization_id`, `id` *and* `meeting_id`: an attendee that belongs to
   * another tenant or another meeting matches nothing and is left untouched (the service has
   * already resolved it scoped, so this is belt-and-braces). Only `rsvp` is written; the identity
   * columns are immutable at the engine (0042's trigger) besides.
   */
  async setRsvp(
    runner: TenantQueryRunner,
    context: TenantContext,
    meetingId: string,
    attendeeId: string,
    rsvp: AttendeeRsvp,
  ): Promise<AttendeeWithUser> {
    const db = tenantDrizzle(runner);
    await db
      .update(meetingAttendees)
      .set({ rsvp })
      .where(
        and(
          eq(meetingAttendees.organizationId, context.organizationId),
          eq(meetingAttendees.meetingId, meetingId),
          eq(meetingAttendees.id, attendeeId),
        ),
      );

    const updated = await this.findWithUser(runner, context, attendeeId);
    if (!updated) {
      // Unreachable: the service resolved the attendee scoped before calling this in the same
      // transaction. A null here would be a torn write.
      throw new Error(`meeting_attendee ${attendeeId} was not found immediately after update`);
    }
    return updated;
  }

  /**
   * Remove an attendee from a meeting (audit gap 8). Scoped by `organization_id`, `meeting_id` and
   * `id`, so another tenant's or another meeting's row matches nothing.
   */
  async remove(
    runner: TenantQueryRunner,
    context: TenantContext,
    meetingId: string,
    attendeeId: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .delete(meetingAttendees)
      .where(
        and(
          eq(meetingAttendees.organizationId, context.organizationId),
          eq(meetingAttendees.meetingId, meetingId),
          eq(meetingAttendees.id, attendeeId),
        ),
      );
  }
}
