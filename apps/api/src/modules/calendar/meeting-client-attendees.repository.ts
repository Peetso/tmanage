import { and, asc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  clientMemberships,
  clientOrganizations,
  meetingAttendees,
  meetingClientAttendees,
  meetings,
  memberships,
  projectClients,
  users,
} from '../../common/database/schema.js';
import type { MeetingClientAttendeeRow, MeetingRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { AttendeeRsvp, StoredAttendeeRsvp } from './meeting-attendees.repository.js';

/**
 * BK5 (0217) — client people as meeting attendees, and the reads the portal's meeting list and
 * detail need. Same rules as every tenant repository here: the runner and the `TenantContext` lead
 * every method, the tenant comes from the context, and every statement carries the
 * `organization_id` predicate (joins are anchored on it), so the tenant guard can prove the scope.
 *
 * "Only clients of this project" is a query predicate, not a post-filter: a candidate is a client
 * membership whose company is in `project_clients` for the meeting's project, active and unexpired.
 */

/** A client person who may be added to a meeting on a project. */
export interface ClientCandidateRow {
  readonly clientMembershipId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly clientOrganizationId: string;
  readonly clientOrganizationName: string;
}

/** A client attendee joined to the person and their company — what a roster read returns. */
export interface ClientAttendeeWithPerson {
  readonly id: string;
  readonly meetingId: string;
  readonly clientMembershipId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly clientOrganizationId: string;
  readonly clientOrganizationName: string;
  readonly rsvp: StoredAttendeeRsvp;
  readonly createdAt: Date;
}

/** A meeting the client attends, with the client's own attendee row. */
export interface ClientMeetingRow {
  readonly meeting: MeetingRow;
  readonly attendeeId: string;
  readonly rsvp: StoredAttendeeRsvp;
}

/** An internal attendee's name and answer, for the portal detail (no ids leave). */
export interface MemberAttendeeName {
  readonly userId: string;
  readonly displayName: string;
  readonly rsvp: StoredAttendeeRsvp;
}

const MAX_ROWS = 500;

export class MeetingClientAttendeesRepository {
  /** Client people of the companies `projectId` is shared with, active now, ordered by name. */
  async listCandidates(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    userId?: string,
  ): Promise<readonly ClientCandidateRow[]> {
    const predicates = [
      eq(clientMemberships.organizationId, context.organizationId),
      eq(projectClients.projectId, projectId),
      eq(clientMemberships.status, 'active'),
      or(isNull(clientMemberships.expiresAt), gt(clientMemberships.expiresAt, new Date())),
    ];
    if (userId !== undefined) predicates.push(eq(clientMemberships.userId, userId));
    return tenantDrizzle(runner)
      .select({
        clientMembershipId: clientMemberships.id,
        userId: clientMemberships.userId,
        displayName: users.displayName,
        clientOrganizationId: clientMemberships.clientOrganizationId,
        clientOrganizationName: clientOrganizations.name,
      })
      .from(clientMemberships)
      .innerJoin(
        projectClients,
        and(
          eq(projectClients.organizationId, clientMemberships.organizationId),
          eq(projectClients.clientOrganizationId, clientMemberships.clientOrganizationId),
        ),
      )
      .innerJoin(
        clientOrganizations,
        and(
          eq(clientOrganizations.organizationId, clientMemberships.organizationId),
          eq(clientOrganizations.id, clientMemberships.clientOrganizationId),
        ),
      )
      .innerJoin(users, eq(users.id, clientMemberships.userId))
      .where(and(...predicates))
      .orderBy(asc(users.displayName), asc(clientMemberships.id))
      .limit(MAX_ROWS);
  }

  /** One meeting's client attendees, in id (≈ creation) order. */
  async listForMeeting(
    runner: TenantQueryRunner,
    context: TenantContext,
    meetingId: string,
  ): Promise<readonly ClientAttendeeWithPerson[]> {
    return this.selectWithPerson(runner, [
      eq(meetingClientAttendees.organizationId, context.organizationId),
      eq(meetingClientAttendees.meetingId, meetingId),
    ]);
  }

  async findWithPerson(
    runner: TenantQueryRunner,
    context: TenantContext,
    attendeeId: string,
  ): Promise<ClientAttendeeWithPerson | null> {
    const rows = await this.selectWithPerson(runner, [
      eq(meetingClientAttendees.organizationId, context.organizationId),
      eq(meetingClientAttendees.id, attendeeId),
    ]);
    return rows[0] ?? null;
  }

  private selectWithPerson(
    runner: TenantQueryRunner,
    predicates: readonly ReturnType<typeof eq>[],
  ): Promise<readonly ClientAttendeeWithPerson[]> {
    return tenantDrizzle(runner)
      .select({
        id: meetingClientAttendees.id,
        meetingId: meetingClientAttendees.meetingId,
        clientMembershipId: meetingClientAttendees.clientMembershipId,
        userId: clientMemberships.userId,
        displayName: users.displayName,
        clientOrganizationId: clientMemberships.clientOrganizationId,
        clientOrganizationName: clientOrganizations.name,
        rsvp: meetingClientAttendees.rsvp,
        createdAt: meetingClientAttendees.createdAt,
      })
      .from(meetingClientAttendees)
      .innerJoin(
        clientMemberships,
        and(
          eq(clientMemberships.organizationId, meetingClientAttendees.organizationId),
          eq(clientMemberships.id, meetingClientAttendees.clientMembershipId),
        ),
      )
      .innerJoin(
        clientOrganizations,
        and(
          eq(clientOrganizations.organizationId, clientMemberships.organizationId),
          eq(clientOrganizations.id, clientMemberships.clientOrganizationId),
        ),
      )
      .innerJoin(users, eq(users.id, clientMemberships.userId))
      .where(and(...predicates))
      .orderBy(asc(meetingClientAttendees.id))
      .limit(MAX_ROWS);
  }

  /** The raw row by id, within the tenant. */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    attendeeId: string,
  ): Promise<MeetingClientAttendeeRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(meetingClientAttendees)
      .where(
        and(
          eq(meetingClientAttendees.organizationId, context.organizationId),
          eq(meetingClientAttendees.id, attendeeId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** A meeting's row for one client membership — the duplicate check and the portal's "is it mine". */
  async findByClientMembership(
    runner: TenantQueryRunner,
    context: TenantContext,
    meetingId: string,
    clientMembershipId: string,
  ): Promise<MeetingClientAttendeeRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(meetingClientAttendees)
      .where(
        and(
          eq(meetingClientAttendees.organizationId, context.organizationId),
          eq(meetingClientAttendees.meetingId, meetingId),
          eq(meetingClientAttendees.clientMembershipId, clientMembershipId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Add a client person; the service has already checked the person belongs to the project. */
  async invite(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: { readonly meetingId: string; readonly clientMembershipId: string },
  ): Promise<ClientAttendeeWithPerson> {
    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(meetingClientAttendees)
      .values({
        id,
        organizationId: context.organizationId,
        meetingId: input.meetingId,
        clientMembershipId: input.clientMembershipId,
        rsvp: 'invited',
        createdAt: sql`current_timestamp(3)`,
      });
    const created = await this.findWithPerson(runner, context, id);
    if (!created) throw new Error(`meeting_client_attendee ${id} was not found after insert`);
    return created;
  }

  async setRsvp(
    runner: TenantQueryRunner,
    context: TenantContext,
    meetingId: string,
    attendeeId: string,
    rsvp: AttendeeRsvp,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(meetingClientAttendees)
      .set({ rsvp })
      .where(
        and(
          eq(meetingClientAttendees.organizationId, context.organizationId),
          eq(meetingClientAttendees.meetingId, meetingId),
          eq(meetingClientAttendees.id, attendeeId),
        ),
      );
  }

  async remove(
    runner: TenantQueryRunner,
    context: TenantContext,
    meetingId: string,
    attendeeId: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .delete(meetingClientAttendees)
      .where(
        and(
          eq(meetingClientAttendees.organizationId, context.organizationId),
          eq(meetingClientAttendees.meetingId, meetingId),
          eq(meetingClientAttendees.id, attendeeId),
        ),
      );
  }

  /** Internal attendees' user ids — the "meeting changed" recipients snapshot. */
  async listMemberUserIds(
    runner: TenantQueryRunner,
    context: TenantContext,
    meetingId: string,
  ): Promise<readonly string[]> {
    const rows = await this.listMemberNames(runner, context, meetingId);
    return rows.map((row) => row.userId);
  }

  /** Internal attendees with their names, for the portal detail. */
  async listMemberNames(
    runner: TenantQueryRunner,
    context: TenantContext,
    meetingId: string,
  ): Promise<readonly MemberAttendeeName[]> {
    return tenantDrizzle(runner)
      .select({
        userId: memberships.userId,
        displayName: users.displayName,
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
  }

  /**
   * The meetings one client membership attends, on projects still shared with its company — the
   * portal list (and, with `meetingId`, the detail). A project unshared later drops out at once.
   */
  async listForClient(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: {
      readonly clientMembershipId: string;
      readonly clientOrganizationId: string;
      readonly meetingId?: string;
    },
  ): Promise<readonly ClientMeetingRow[]> {
    const predicates = [
      eq(meetings.organizationId, context.organizationId),
      eq(meetingClientAttendees.clientMembershipId, input.clientMembershipId),
      eq(projectClients.clientOrganizationId, input.clientOrganizationId),
    ];
    if (input.meetingId !== undefined) predicates.push(eq(meetings.id, input.meetingId));
    const rows = await tenantDrizzle(runner)
      .select({
        meeting: meetings,
        attendeeId: meetingClientAttendees.id,
        rsvp: meetingClientAttendees.rsvp,
      })
      .from(meetings)
      .innerJoin(
        meetingClientAttendees,
        and(
          eq(meetingClientAttendees.organizationId, meetings.organizationId),
          eq(meetingClientAttendees.meetingId, meetings.id),
        ),
      )
      .innerJoin(
        projectClients,
        and(
          eq(projectClients.organizationId, meetings.organizationId),
          eq(projectClients.projectId, meetings.projectId),
        ),
      )
      .where(and(...predicates))
      .orderBy(asc(meetings.startsAt), asc(meetings.id))
      .limit(MAX_ROWS);
    return rows;
  }
}
