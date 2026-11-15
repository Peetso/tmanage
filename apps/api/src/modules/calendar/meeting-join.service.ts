import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { MeetingRow } from '../../common/database/schema.js';
import { MeetingsRepository } from './meetings.repository.js';
import { MeetingCalendarRepository } from './meeting-calendar.repository.js';
import type { RosterEntry } from './meeting-calendar.repository.js';
import { MeetingClientAttendeesRepository } from './meeting-client-attendees.repository.js';
import { MeetingJoinRepository } from './meeting-join.repository.js';
import {
  attendanceStatus,
  joinWindow,
  normaliseCallUrl,
  planAttendance,
  providerOf,
  quickRoomUrl,
} from './meeting-join.js';
import type { AttendanceStatus, CallProvider, JoinWindowState } from './meeting-join.js';
import type { MeetingsService, MeetingView } from './meetings.service.js';

/**
 * 53-12 — the meeting join flow, attendance and quick room.
 *
 * **Join** hands out the call URL only to a person invited to that meeting — an internal attendee
 * row (staff route) or the caller's own client attendee row on a project still shared with their
 * company (portal route) — inside the join window, and records attendance server-side at the same
 * time. Anyone else gets the meeting's ordinary 404 (they cannot read it) or a bare 403 (they can
 * read the project but were not invited): no URL, no provider, no time.
 *
 * The URL comes from the meeting's own call link (pasted, or a quick room) or else from the
 * Meet/Teams event minted by the organizer's calendar (0237), and is re-checked against the host
 * allow-list on the way out. The server never fetches it.
 */

export type CallKind = 'calendar' | 'link' | 'quick_room';

/** What the meeting page shows about the call. `url` is null for anyone not invited. */
export interface MeetingCallView {
  readonly kind: CallKind | null;
  readonly provider: CallProvider | null;
  /** The bare host (`meet.google.com`), shown beside the icon. */
  readonly host: string | null;
  readonly url: string | null;
  readonly invited: boolean;
  readonly joinState: JoinWindowState;
  readonly opensAt: string;
  readonly closesAt: string;
}

export interface MeetingJoinView {
  readonly url: string;
  readonly kind: CallKind;
  readonly provider: CallProvider;
  /** When this person first joined (unchanged by a second click). */
  readonly joinedAt: string;
}

export interface MeetingAttendancePerson {
  readonly userId: string;
  readonly kind: 'member' | 'client';
  readonly displayName: string | null;
  readonly organizer: boolean;
  readonly status: AttendanceStatus;
  readonly lateMinutes: number | null;
  readonly joinedAt: string | null;
  readonly lastJoinedAt: string | null;
  readonly source: 'join_click' | 'manual' | null;
}

export interface MeetingAttendanceView {
  readonly meetingId: string;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly joinState: JoinWindowState;
  readonly people: readonly MeetingAttendancePerson[];
}

interface ResolvedCall {
  readonly kind: CallKind;
  readonly url: string;
}

const notVisible = (): ApiError =>
  new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'meeting_not_visible');

/**
 * A Join that cannot happen yet (or any more): 409 `conflict`, the reason in `details[0]` (`join`:
 * `not_open`, `ended`, `cancelled` or `no_call_link`) and, for `not_open`, when it opens.
 */
export type JoinRefusal = 'not_open' | 'ended' | 'cancelled' | 'no_call_link';

function joinConflict(reason: JoinRefusal, message: string, opensAt?: Date): ApiError {
  return new ApiError(409, 'conflict', message, [
    { field: 'join', message: reason },
    ...(opensAt ? [{ field: 'opensAt', message: opensAt.toISOString() }] : []),
  ]);
}

export class MeetingJoinService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly meetings: MeetingsRepository = new MeetingsRepository(),
    private readonly calendar: MeetingCalendarRepository = new MeetingCalendarRepository(),
    private readonly join: MeetingJoinRepository = new MeetingJoinRepository(),
    private readonly clientRoster: MeetingClientAttendeesRepository = new MeetingClientAttendeesRepository(),
    /** Creates the ad-hoc meeting behind a new quick room. Absent in the database-free suites. */
    private readonly meetingsService?: MeetingsService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Tenant-scoped read plus the project relation check; 404 for anything the caller cannot read. */
  private async resolve(
    context: TenantContext,
    principal: Principal,
    meetingId: string,
    capability: 'work.read' | 'work.create',
  ): Promise<MeetingRow> {
    const meeting = await this.database.read(context, (runner) =>
      this.meetings.findById(runner, context, meetingId),
    );
    if (!meeting || meeting.deletedAt) throw notVisible();
    const permitted = authorize({
      principal,
      capability,
      resource: {
        organizationId: meeting.organizationId,
        projectId: meeting.projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
    if (!permitted) throw notVisible();
    return meeting;
  }

  private async callOf(context: TenantContext, meetingId: string): Promise<ResolvedCall | null> {
    const [own, external] = await this.database.read(context, (runner) =>
      Promise.all([
        this.join.findCallLink(runner, context, meetingId),
        this.calendar.findLink(runner, context, meetingId),
      ]),
    );
    const ownUrl = own ? normaliseCallUrl(own.url) : null;
    if (own && ownUrl) return { kind: own.kind, url: ownUrl };
    const calendarUrl = external?.joinUrl ? normaliseCallUrl(external.joinUrl) : null;
    return calendarUrl ? { kind: 'calendar', url: calendarUrl } : null;
  }

  private roster(context: TenantContext, meetingId: string): Promise<readonly RosterEntry[]> {
    return this.database.read(context, (runner) =>
      this.calendar.roster(runner, context, meetingId),
    );
  }

  private toCallView(
    meeting: MeetingRow,
    call: ResolvedCall | null,
    invited: boolean,
  ): MeetingCallView {
    const window = joinWindow(meeting.startsAt, meeting.endsAt, this.clock());
    return {
      kind: call?.kind ?? null,
      provider: call ? providerOf(call.url) : null,
      host: call ? new URL(call.url).hostname : null,
      url: call && invited ? call.url : null,
      invited,
      joinState: window.state,
      opensAt: window.opensAt.toISOString(),
      closesAt: window.closesAt.toISOString(),
    };
  }

  /** The call card: provider and host for every reader, the URL only for an invited member. */
  async call(
    context: TenantContext,
    principal: Principal,
    meetingId: string,
  ): Promise<MeetingCallView> {
    const meeting = await this.resolve(context, principal, meetingId, 'work.read');
    const roster = await this.roster(context, meetingId);
    const invited = roster.some((p) => p.kind === 'member' && p.userId === principal.userId);
    return this.toCallView(meeting, await this.callOf(context, meetingId), invited);
  }

  /** Staff Join: an invited member, inside the window. Records attendance, returns the URL. */
  async joinAsMember(
    context: TenantContext,
    principal: Principal,
    meetingId: string,
  ): Promise<MeetingJoinView> {
    const meeting = await this.resolve(context, principal, meetingId, 'work.read');
    const roster = await this.roster(context, meetingId);
    if (!roster.some((p) => p.kind === 'member' && p.userId === principal.userId)) {
      throw new ApiError(403, 'forbidden', 'Only people invited to this meeting can join it.');
    }
    return this.record(context, meeting, principal.userId, 'member');
  }

  /** The client person's own meeting (their attendee row, project still shared), else 404. */
  private async ownClientMeeting(
    context: TenantContext,
    principal: Principal,
    meetingId: string,
  ): Promise<MeetingRow> {
    if (principal.kind !== 'client' || principal.clientOrganizationId === null) throw notVisible();
    const scope = {
      clientMembershipId: principal.membershipId,
      clientOrganizationId: principal.clientOrganizationId,
      meetingId,
    };
    const rows = await this.database.read(context, (runner) =>
      this.clientRoster.listForClient(runner, context, scope),
    );
    const own = rows[0];
    if (!own || own.meeting.deletedAt) throw notVisible();
    return own.meeting;
  }

  /** The portal call card: provider, host and the join window. The URL comes only from Join. */
  async clientCall(
    context: TenantContext,
    principal: Principal,
    meetingId: string,
  ): Promise<MeetingCallView> {
    const meeting = await this.ownClientMeeting(context, principal, meetingId);
    return { ...this.toCallView(meeting, await this.callOf(context, meetingId), true), url: null };
  }

  /** Portal Join: the client person's own attendee row, project still shared with them. */
  async joinAsClient(
    context: TenantContext,
    principal: Principal,
    meetingId: string,
  ): Promise<MeetingJoinView> {
    const meeting = await this.ownClientMeeting(context, principal, meetingId);
    return this.record(context, meeting, principal.userId, 'client');
  }

  private async record(
    context: TenantContext,
    meeting: MeetingRow,
    userId: string,
    attendeeKind: 'member' | 'client',
  ): Promise<MeetingJoinView> {
    if (meeting.cancelledAt) {
      throw joinConflict('cancelled', 'This meeting was cancelled.');
    }
    const now = this.clock();
    const window = joinWindow(meeting.startsAt, meeting.endsAt, now);
    if (window.state === 'not_open') {
      throw joinConflict('not_open', 'Join opens 10 minutes before the start.', window.opensAt);
    }
    if (window.state === 'ended') {
      throw joinConflict('ended', 'This meeting has ended.');
    }
    const call = await this.callOf(context, meeting.id);
    if (!call) throw joinConflict('no_call_link', 'This meeting has no call link yet.');

    const joinedAt = await this.database.transaction(context, async (tx) => {
      const existing = await this.join.findAttendance(tx, context, meeting.id, userId);
      const plan = planAttendance(existing, now);
      if (plan.kind === 'insert') {
        await this.join.insertJoin(tx, context, {
          meetingId: meeting.id,
          userId,
          attendeeKind,
          joinedAt: plan.joinedAt,
        });
        return plan.joinedAt;
      }
      await this.join.touchJoin(tx, context, existing!.id, plan.firstJoinedAt, plan.lastJoinedAt);
      return plan.firstJoinedAt;
    });
    return {
      url: call.url,
      kind: call.kind,
      provider: providerOf(call.url),
      joinedAt: joinedAt.toISOString(),
    };
  }

  /** Who joined: everyone invited (members and client people), with their attendance. */
  async attendance(
    context: TenantContext,
    principal: Principal,
    meetingId: string,
  ): Promise<MeetingAttendanceView> {
    const meeting = await this.resolve(context, principal, meetingId, 'work.read');
    const [roster, rows] = await Promise.all([
      this.roster(context, meetingId),
      this.database.read(context, (runner) => this.join.listAttendance(runner, context, meetingId)),
    ]);
    const window = joinWindow(meeting.startsAt, meeting.endsAt, this.clock());
    const byUser = new Map(rows.map((row) => [row.userId, row]));
    const people = roster
      .filter((p): p is RosterEntry & { userId: string } => p.kind !== 'guest' && !!p.userId)
      .map((p): MeetingAttendancePerson => {
        const row = byUser.get(p.userId) ?? null;
        const shown = attendanceStatus(row, meeting.startsAt, window);
        return {
          userId: p.userId,
          kind: p.kind === 'client' ? 'client' : 'member',
          displayName: p.displayName,
          organizer: p.userId === meeting.createdByUserId,
          status: shown.status,
          lateMinutes: shown.lateMinutes,
          joinedAt: row?.firstJoinedAt ? row.firstJoinedAt.toISOString() : null,
          lastJoinedAt: row?.lastJoinedAt ? row.lastJoinedAt.toISOString() : null,
          source: row?.source ?? null,
        };
      });
    return {
      meetingId: meeting.id,
      title: meeting.title,
      startsAt: meeting.startsAt.toISOString(),
      endsAt: meeting.endsAt ? meeting.endsAt.toISOString() : null,
      joinState: window.state,
      people,
    };
  }

  /** "Mark present" / "Mark absent" for someone on the meeting. */
  async mark(
    context: TenantContext,
    principal: Principal,
    meetingId: string,
    userId: string,
    status: 'present' | 'absent',
  ): Promise<MeetingAttendanceView> {
    await this.resolve(context, principal, meetingId, 'work.create');
    const person = (await this.roster(context, meetingId)).find(
      (p) => p.kind !== 'guest' && p.userId === userId,
    );
    if (!person) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    await this.database.transaction(context, (tx) =>
      this.join.mark(tx, context, {
        meetingId,
        userId,
        attendeeKind: person.kind === 'client' ? 'client' : 'member',
        status,
        markedByUserId: principal.userId,
      }),
    );
    return this.attendance(context, principal, meetingId);
  }

  /** "Add call link": an allow-listed https meeting link, or `null` to remove it ("End room"). */
  async setCall(
    context: TenantContext,
    principal: Principal,
    meetingId: string,
    rawUrl: unknown,
  ): Promise<MeetingCallView> {
    const meeting = await this.resolve(context, principal, meetingId, 'work.create');
    if (rawUrl === null) {
      await this.database.transaction(context, (tx) =>
        this.join.clearCallLink(tx, context, meetingId),
      );
    } else {
      const url = normaliseCallUrl(rawUrl);
      if (!url) {
        throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
          {
            field: 'url',
            message: 'must be an https link to Google Meet, Teams, Zoom, Webex, Whereby or Jitsi',
          },
        ]);
      }
      await this.database.transaction(context, (tx) =>
        this.join.setCallLink(tx, context, {
          meetingId,
          kind: 'link',
          url,
          setByUserId: principal.userId,
        }),
      );
    }
    return this.call(context, principal, meeting.id);
  }

  /** "Start quick room" on a meeting: a fresh meet.jit.si room with an unguessable name. */
  async startQuickRoom(
    context: TenantContext,
    principal: Principal,
    meetingId: string,
  ): Promise<MeetingCallView> {
    const meeting = await this.resolve(context, principal, meetingId, 'work.create');
    if (meeting.cancelledAt) throw joinConflict('cancelled', 'This meeting was cancelled.');
    await this.database.transaction(context, (tx) =>
      this.join.setCallLink(tx, context, {
        meetingId,
        kind: 'quick_room',
        url: quickRoomUrl(),
        setByUserId: principal.userId,
      }),
    );
    return this.call(context, principal, meeting.id);
  }

  /** An ad-hoc meeting that starts now (30 min) with a quick room, the caller as organizer. */
  async createQuickRoom(
    context: TenantContext,
    principal: Principal,
    input: { readonly projectId: string; readonly title: string },
  ): Promise<{ readonly meeting: MeetingView; readonly call: MeetingCallView }> {
    if (!this.meetingsService) throw new Error('MeetingJoinService has no MeetingsService');
    const now = this.clock();
    const meeting = await this.meetingsService.create(context, principal, {
      projectId: input.projectId,
      title: input.title,
      startsAt: now,
      endsAt: new Date(now.getTime() + 30 * 60_000),
    });
    const call = await this.startQuickRoom(context, principal, meeting.id);
    return { meeting, call };
  }
}
