import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  clientMemberships,
  meetingAttachments,
  meetingAttendees,
  meetingClientAttendees,
  meetingExternalEvents,
  meetingGuests,
  memberships,
  users,
} from '../../common/database/schema.js';
import type {
  MeetingAttachmentRow,
  MeetingExternalEventRow,
  MeetingGuestRow,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { StoredAttendeeRsvp } from './meeting-attendees.repository.js';

/**
 * 0237. The data half of a meeting's calendar side: email-only guests, attachments, the provider
 * event link, and the roster with email addresses (what a provider event's attendee list is made
 * of). Every statement carries `organization_id = context.organizationId`; joins are anchored on it.
 */

export type GuestRsvp = StoredAttendeeRsvp;
export const GUEST_RSVPS: readonly GuestRsvp[] = ['invited', 'accepted', 'declined', 'tentative'];

/** One person on a meeting, with the address the provider knows them by. */
export interface RosterEntry {
  readonly kind: 'member' | 'client' | 'guest';
  /** The attendee or guest row id. */
  readonly id: string;
  /** `null` for a guest. */
  readonly userId: string | null;
  readonly displayName: string | null;
  readonly email: string;
  readonly optional: boolean;
  readonly rsvp: StoredAttendeeRsvp;
}

export interface InsertGuestInput {
  readonly meetingId: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly optional: boolean;
}

export interface InsertAttachmentInput {
  readonly meetingId: string;
  readonly provider: 'google_drive' | 'onedrive';
  readonly fileId: string;
  readonly driveId: string | null;
  readonly title: string;
  readonly mimeType: string;
  readonly webUrl: string | null;
  readonly attachedByUserId: string;
}

export interface LinkPatch {
  readonly connectionId?: string;
  readonly externalEventId?: string | null;
  readonly externalCalendarId?: string | null;
  readonly icalUid?: string | null;
  readonly joinUrl?: string | null;
  readonly htmlLink?: string | null;
  readonly externalVersion?: string | null;
  readonly syncStatus?: 'pending' | 'synced' | 'error' | 'deleted';
  readonly lastErrorCode?: string | null;
  readonly lastPushedAt?: Date;
  readonly lastPulledAt?: Date;
}

const MAX_ROWS = 500;

function toRsvp(raw: string): StoredAttendeeRsvp {
  return (GUEST_RSVPS as readonly string[]).includes(raw) ? (raw as StoredAttendeeRsvp) : 'invited';
}

export class MeetingCalendarRepository {
  // ── Roster with emails ────────────────────────────────────────────────────

  async roster(
    runner: TenantQueryRunner,
    context: TenantContext,
    meetingId: string,
  ): Promise<readonly RosterEntry[]> {
    const db = tenantDrizzle(runner);
    const members = await db
      .select({
        id: meetingAttendees.id,
        userId: memberships.userId,
        displayName: users.displayName,
        email: users.email,
        optional: meetingAttendees.optional,
        rsvp: meetingAttendees.rsvp,
      })
      .from(meetingAttendees)
      .innerJoin(
        memberships,
        and(
          eq(memberships.organizationId, meetingAttendees.organizationId),
          eq(memberships.id, meetingAttendees.membershipId),
        ),
      )
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(meetingAttendees.organizationId, context.organizationId),
          eq(meetingAttendees.meetingId, meetingId),
        ),
      )
      .orderBy(asc(meetingAttendees.id))
      .limit(MAX_ROWS);
    const clients = await db
      .select({
        id: meetingClientAttendees.id,
        userId: clientMemberships.userId,
        displayName: users.displayName,
        email: users.email,
        optional: meetingClientAttendees.optional,
        rsvp: meetingClientAttendees.rsvp,
      })
      .from(meetingClientAttendees)
      .innerJoin(
        clientMemberships,
        and(
          eq(clientMemberships.organizationId, meetingClientAttendees.organizationId),
          eq(clientMemberships.id, meetingClientAttendees.clientMembershipId),
        ),
      )
      .innerJoin(users, eq(users.id, clientMemberships.userId))
      .where(
        and(
          eq(meetingClientAttendees.organizationId, context.organizationId),
          eq(meetingClientAttendees.meetingId, meetingId),
        ),
      )
      .orderBy(asc(meetingClientAttendees.id))
      .limit(MAX_ROWS);
    const guests = await this.listGuests(runner, context, meetingId);
    return [
      ...members.map((m) => ({ kind: 'member' as const, ...m, email: m.email.toLowerCase() })),
      ...clients.map((c) => ({ kind: 'client' as const, ...c, email: c.email.toLowerCase() })),
      ...guests.map((g) => ({
        kind: 'guest' as const,
        id: g.id,
        userId: null,
        displayName: g.displayName,
        email: g.email,
        optional: g.optional,
        rsvp: toRsvp(g.rsvp),
      })),
    ];
  }

  /** Write an answer that came from the provider onto the roster row it belongs to. */
  async setRosterRsvp(
    runner: TenantQueryRunner,
    context: TenantContext,
    entry: Pick<RosterEntry, 'kind' | 'id'>,
    meetingId: string,
    rsvp: StoredAttendeeRsvp,
  ): Promise<void> {
    const db = tenantDrizzle(runner);
    if (entry.kind === 'member') {
      await db
        .update(meetingAttendees)
        .set({ rsvp })
        .where(
          and(
            eq(meetingAttendees.organizationId, context.organizationId),
            eq(meetingAttendees.meetingId, meetingId),
            eq(meetingAttendees.id, entry.id),
          ),
        );
    } else if (entry.kind === 'client') {
      await db
        .update(meetingClientAttendees)
        .set({ rsvp })
        .where(
          and(
            eq(meetingClientAttendees.organizationId, context.organizationId),
            eq(meetingClientAttendees.meetingId, meetingId),
            eq(meetingClientAttendees.id, entry.id),
          ),
        );
    } else {
      await db
        .update(meetingGuests)
        .set({ rsvp })
        .where(
          and(
            eq(meetingGuests.organizationId, context.organizationId),
            eq(meetingGuests.meetingId, meetingId),
            eq(meetingGuests.id, entry.id),
          ),
        );
    }
  }

  /** The `optional` flag of a member attendee, set in the create transaction. */
  async setMemberOptional(
    runner: TenantQueryRunner,
    context: TenantContext,
    meetingId: string,
    membershipId: string,
    optional: boolean,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(meetingAttendees)
      .set({ optional })
      .where(
        and(
          eq(meetingAttendees.organizationId, context.organizationId),
          eq(meetingAttendees.meetingId, meetingId),
          eq(meetingAttendees.membershipId, membershipId),
        ),
      );
  }

  // ── Guests ────────────────────────────────────────────────────────────────

  async listGuests(
    runner: TenantQueryRunner,
    context: TenantContext,
    meetingId: string,
  ): Promise<readonly MeetingGuestRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(meetingGuests)
      .where(
        and(
          eq(meetingGuests.organizationId, context.organizationId),
          eq(meetingGuests.meetingId, meetingId),
        ),
      )
      .orderBy(asc(meetingGuests.id))
      .limit(MAX_ROWS);
  }

  /** Insert, or (same email again) update the name and the optional flag. */
  async upsertGuest(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: InsertGuestInput,
  ): Promise<MeetingGuestRow> {
    const db = tenantDrizzle(runner);
    await db
      .insert(meetingGuests)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        meetingId: input.meetingId,
        email: input.email,
        displayName: input.displayName,
        optional: input.optional,
        rsvp: 'invited',
        createdAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({
        set: { displayName: input.displayName, optional: input.optional },
      });
    const rows = await db
      .select()
      .from(meetingGuests)
      .where(
        and(
          eq(meetingGuests.organizationId, context.organizationId),
          eq(meetingGuests.meetingId, input.meetingId),
          eq(meetingGuests.email, input.email),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) throw new Error('meeting guest vanished after insert');
    return row;
  }

  /** `true` when a guest of this meeting was removed. */
  async deleteGuest(
    runner: TenantQueryRunner,
    context: TenantContext,
    meetingId: string,
    guestId: string,
  ): Promise<boolean> {
    const db = tenantDrizzle(runner);
    const found = await db
      .select({ id: meetingGuests.id })
      .from(meetingGuests)
      .where(
        and(
          eq(meetingGuests.organizationId, context.organizationId),
          eq(meetingGuests.meetingId, meetingId),
          eq(meetingGuests.id, guestId),
        ),
      )
      .limit(1);
    if (found.length === 0) return false;
    await db
      .delete(meetingGuests)
      .where(
        and(
          eq(meetingGuests.organizationId, context.organizationId),
          eq(meetingGuests.meetingId, meetingId),
          eq(meetingGuests.id, guestId),
        ),
      );
    return true;
  }

  // ── Attachments ───────────────────────────────────────────────────────────

  async listAttachments(
    runner: TenantQueryRunner,
    context: TenantContext,
    meetingId: string,
  ): Promise<readonly MeetingAttachmentRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(meetingAttachments)
      .where(
        and(
          eq(meetingAttachments.organizationId, context.organizationId),
          eq(meetingAttachments.meetingId, meetingId),
          isNull(meetingAttachments.removedAt),
        ),
      )
      .orderBy(asc(meetingAttachments.id))
      .limit(MAX_ROWS);
  }

  async insertAttachment(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: InsertAttachmentInput,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(meetingAttachments)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        ...input,
        createdAt: sql`current_timestamp(3)`,
      });
  }

  // ── The provider event link ───────────────────────────────────────────────

  async findLink(
    runner: TenantQueryRunner,
    context: TenantContext,
    meetingId: string,
    provider?: string,
  ): Promise<MeetingExternalEventRow | null> {
    const predicates = [
      eq(meetingExternalEvents.organizationId, context.organizationId),
      eq(meetingExternalEvents.meetingId, meetingId),
    ];
    if (provider !== undefined) predicates.push(eq(meetingExternalEvents.provider, provider));
    const rows = await tenantDrizzle(runner)
      .select()
      .from(meetingExternalEvents)
      .where(and(...predicates))
      .orderBy(asc(meetingExternalEvents.id))
      .limit(1);
    return rows[0] ?? null;
  }

  async findLinkByEvent(
    runner: TenantQueryRunner,
    context: TenantContext,
    connectionId: string,
    externalEventId: string,
  ): Promise<MeetingExternalEventRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(meetingExternalEvents)
      .where(
        and(
          eq(meetingExternalEvents.organizationId, context.organizationId),
          eq(meetingExternalEvents.connectionId, connectionId),
          eq(meetingExternalEvents.externalEventId, externalEventId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Create the link for (meeting, provider), or patch it in place. */
  async saveLink(
    runner: TenantQueryRunner,
    context: TenantContext,
    meetingId: string,
    provider: string,
    patch: LinkPatch & { readonly connectionId: string },
  ): Promise<void> {
    const db = tenantDrizzle(runner);
    const set = { ...patch, updatedAt: sql`current_timestamp(3)` };
    await db
      .insert(meetingExternalEvents)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        meetingId,
        provider,
        ...patch,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({ set });
  }

  async patchLink(
    runner: TenantQueryRunner,
    context: TenantContext,
    linkId: string,
    patch: LinkPatch,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(meetingExternalEvents)
      .set({ ...patch, updatedAt: sql`current_timestamp(3)` })
      .where(
        and(
          eq(meetingExternalEvents.organizationId, context.organizationId),
          eq(meetingExternalEvents.id, linkId),
        ),
      );
  }
}
