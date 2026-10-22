import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { MeetingClientAttendeesRepository } from './meeting-client-attendees.repository.js';
import type { ClientMeetingRow } from './meeting-client-attendees.repository.js';
import type { AttendeeRsvp } from './meeting-attendees.repository.js';

/**
 * BK5 (0217) — the client portal's meetings: a client person sees **only the meetings they attend**,
 * and only while the meeting's project is still shared with their company. Both rules are predicates
 * of the one query (`listForClient`), keyed on the principal's own client membership and client
 * organization, so there is no parameter a client could use to name another person or company.
 *
 * An internal caller holds `client_projection.read` too, but has no client membership, so the list
 * is empty and a detail is 404 — this surface is the client's own, never a window onto the roster.
 *
 * The agenda note is deliberately not projected: it is written by the studio for the studio, and
 * nothing marks it client-safe.
 */

export interface PortalMeetingView {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string | null;
  /** The caller's own attendee row and answer. */
  readonly attendeeId: string;
  readonly rsvp: AttendeeRsvp;
}

/** One person on the meeting as the client sees them: a name, a side, an answer. No ids. */
export interface PortalMeetingAttendeeView {
  readonly displayName: string;
  readonly kind: 'team' | 'client';
  readonly organizer: boolean;
  readonly rsvp: AttendeeRsvp;
}

export interface PortalMeetingDetailView extends PortalMeetingView {
  readonly attendees: readonly PortalMeetingAttendeeView[];
}

function toView(row: ClientMeetingRow): PortalMeetingView {
  return {
    id: row.meeting.id,
    projectId: row.meeting.projectId,
    title: row.meeting.title,
    startsAt: row.meeting.startsAt.toISOString(),
    endsAt: row.meeting.endsAt ? row.meeting.endsAt.toISOString() : null,
    attendeeId: row.attendeeId,
    rsvp: row.rsvp,
  };
}

export class PortalMeetingsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly roster: MeetingClientAttendeesRepository = new MeetingClientAttendeesRepository(),
  ) {}

  private clientScope(
    principal: Principal,
  ): { readonly clientMembershipId: string; readonly clientOrganizationId: string } | null {
    if (principal.kind !== 'client' || principal.clientOrganizationId === null) return null;
    return {
      clientMembershipId: principal.membershipId,
      clientOrganizationId: principal.clientOrganizationId,
    };
  }

  private async own(
    context: TenantContext,
    principal: Principal,
    meetingId: string,
  ): Promise<ClientMeetingRow> {
    const scope = this.clientScope(principal);
    const rows = scope
      ? await this.database.read(context, (runner) =>
          this.roster.listForClient(runner, context, { ...scope, meetingId }),
        )
      : [];
    const row = rows[0];
    if (!row) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'meeting_not_visible');
    }
    return row;
  }

  /** The meetings the calling client person attends, soonest first. */
  async list(context: TenantContext, principal: Principal): Promise<readonly PortalMeetingView[]> {
    const scope = this.clientScope(principal);
    if (!scope) return [];
    const rows = await this.database.read(context, (runner) =>
      this.roster.listForClient(runner, context, scope),
    );
    return rows.map(toView);
  }

  /** One meeting the caller attends, with who else is on it. 404 for anything else. */
  async get(
    context: TenantContext,
    principal: Principal,
    meetingId: string,
  ): Promise<PortalMeetingDetailView> {
    const row = await this.own(context, principal, meetingId);
    const [members, clients] = await this.database.read(context, (runner) =>
      Promise.all([
        this.roster.listMemberNames(runner, context, meetingId),
        this.roster.listForMeeting(runner, context, meetingId),
      ]),
    );
    const attendees: PortalMeetingAttendeeView[] = [
      ...members.map((member) => ({
        displayName: member.displayName,
        kind: 'team' as const,
        organizer: member.userId === row.meeting.createdByUserId,
        rsvp: member.rsvp,
      })),
      ...clients.map((client) => ({
        displayName: client.displayName,
        kind: 'client' as const,
        organizer: false,
        rsvp: client.rsvp,
      })),
    ];
    return { ...toView(row), attendees };
  }

  /** The caller answers for themselves — accepted or declined. */
  async setRsvp(
    context: TenantContext,
    principal: Principal,
    meetingId: string,
    rsvp: 'accepted' | 'declined',
  ): Promise<PortalMeetingView> {
    const row = await this.own(context, principal, meetingId);
    await this.database.transaction(context, (tx) =>
      this.roster.setRsvp(tx, context, meetingId, row.attendeeId, rsvp),
    );
    return toView({ ...row, rsvp });
  }
}
