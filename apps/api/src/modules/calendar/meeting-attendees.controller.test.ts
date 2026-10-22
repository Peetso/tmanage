import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { CLIENT_ROLES, INTERNAL_ROLES, capabilitiesFor } from '@tmanage/domain';
import type { Capability } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { MeetingAttendeesController } from './meeting-attendees.controller.js';
import { MeetingAttendeesService } from './meeting-attendees.service.js';
import type { AttendeeWithUser } from './meeting-attendees.repository.js';
import type { MeetingAttendeesRepository } from './meeting-attendees.repository.js';
import type { MeetingsRepository } from './meetings.repository.js';
import type { MembershipsRepository } from '../tenancy/memberships.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type {
  MeetingAttendeeRow,
  MeetingRow,
  MembershipRow,
} from '../../common/database/schema.js';

/**
 * CAL-01 / MTG-01 attendees + RSVP (x126) proofs, database-free over the module's fakes and with
 * the *real* `authorize()` in the loop — the SQL round-trip and the migration are the chain's DB
 * suites, not re-proven here. What only this file proves is the slice's own logic:
 *
 * - invite → list → RSVP for a project member (the happy path);
 * - a cross-tenant meeting / cross-meeting attendee id is 404 with no write (the Known-trap order);
 * - an illegal RSVP is 409 with no write (the controller rejects it before the service);
 * - the routes declare `meeting.read`/`meeting.write`, held by internal roles and no client role
 *   (the 403 boundary, from the capability ceiling rather than a check a handler could forget).
 *
 * The fakes deliberately do **not** re-apply the tenant scope the real SQL applies, so the
 * service's own resolution must carry the isolation.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const MEETING = 'meeting-0000-0000-0000-00000000000001';
const OTHER_MEETING = 'meeting-0000-0000-0000-00000000000002';
const USER = 'user-0000-0000-0000-0000-000000000001';
const INVITEE = 'user-0000-0000-0000-0000-0000000000a1';
const MEMBERSHIP = 'membership-0000-0000-0000-0000-0000000001';

function member(projectIds: readonly string[], hasOrgWideScope = false): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role: hasOrgWideScope ? 'owner' : 'member',
    membershipId: 'membership-0000-0000-0000-0000-0000000009',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope,
  };
}

/**
 * The invited member acting for themselves — their `membershipId` matches the attendee row the
 * invite creates (`membersByUser[INVITEE]` → `MEMBERSHIP`), so they may set their own RSVP (CQ-15,
 * COL-11).
 */
function invitedMember(): Principal {
  return {
    userId: INVITEE,
    organizationId: ORG,
    kind: 'internal',
    role: 'member',
    membershipId: MEMBERSHIP,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [PROJECT],
    hasOrgWideScope: false,
  };
}

const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

function meetingRow(overrides: Partial<MeetingRow> = {}): MeetingRow {
  return {
    id: MEETING,
    organizationId: ORG,
    projectId: PROJECT,
    title: 'Kickoff',
    startsAt: new Date('2026-10-01T14:00:00.000Z'),
    agendaNote: null,
    createdByUserId: USER,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as MeetingRow;
}

/**
 * A service over in-memory stores whose reads omit the tenant scope on purpose. `knownMeetings`
 * and `knownMembersByUser` stand in for what resolves inside the acting tenant.
 */
function serviceWith(options: {
  meetings?: readonly MeetingRow[];
  membersByUser?: Readonly<Record<string, string>>;
  attendees?: readonly (MeetingAttendeeRow & { readonly userId: string })[];
}): { service: MeetingAttendeesService; store: (MeetingAttendeeRow & { userId: string })[] } {
  const meetings = options.meetings ?? [meetingRow()];
  const membersByUser = options.membersByUser ?? { [INVITEE]: MEMBERSHIP };
  const store: (MeetingAttendeeRow & { userId: string })[] = [...(options.attendees ?? [])];
  let seq = store.length;

  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const withUser = (row: MeetingAttendeeRow & { userId: string }): AttendeeWithUser => ({
    id: row.id,
    meetingId: row.meetingId,
    userId: row.userId,
    rsvp: row.rsvp,
    createdAt: row.createdAt,
  });

  const attendeesRepo = {
    list: async (_r: unknown, _c: unknown, o: { readonly meetingId: string }) =>
      store.filter((row) => row.meetingId === o.meetingId).map(withUser),
    findById: async (_r: unknown, _c: unknown, attendeeId: string) =>
      store.find((row) => row.id === attendeeId && row.organizationId === ORG) ?? null,
    findWithUser: async (_r: unknown, _c: unknown, attendeeId: string) => {
      const row = store.find((r) => r.id === attendeeId && r.organizationId === ORG);
      return row ? withUser(row) : null;
    },
    findByMembership: async (_r: unknown, _c: unknown, meetingId: string, membershipId: string) =>
      store.find(
        (row) =>
          row.organizationId === ORG &&
          row.meetingId === meetingId &&
          row.membershipId === membershipId,
      ) ?? null,
    invite: async (
      _r: unknown,
      _c: unknown,
      input: { readonly meetingId: string; readonly membershipId: string; readonly rsvp: string },
    ) => {
      const userId =
        Object.entries(membersByUser).find(([, m]) => m === input.membershipId)?.[0] ?? INVITEE;
      const row = {
        id: `attendee-0000-0000-0000-00000000000${++seq}`,
        organizationId: ORG,
        meetingId: input.meetingId,
        membershipId: input.membershipId,
        rsvp: input.rsvp,
        createdAt: new Date(),
        userId,
      } as MeetingAttendeeRow & { userId: string };
      store.push(row);
      return withUser(row);
    },
    setRsvp: async (
      _r: unknown,
      _c: unknown,
      meetingId: string,
      attendeeId: string,
      rsvp: string,
    ) => {
      const row = store.find((r) => r.id === attendeeId && r.meetingId === meetingId);
      if (!row) throw new Error('missing');
      row.rsvp = rsvp as MeetingAttendeeRow['rsvp'];
      return withUser(row);
    },
  } as unknown as MeetingAttendeesRepository;

  const meetingsRepo = {
    findById: async (_r: unknown, _c: unknown, meetingId: string) =>
      meetings.find((m) => m.id === meetingId && m.organizationId === ORG) ?? null,
  } as unknown as MeetingsRepository;

  const membershipsRepo = {
    findByUserId: async (_r: unknown, _c: unknown, userId: string) =>
      membersByUser[userId]
        ? ({ id: membersByUser[userId], status: 'active' } as unknown as MembershipRow)
        : null,
  } as unknown as MembershipsRepository;

  return {
    service: new MeetingAttendeesService(database, attendeesRepo, meetingsRepo, membershipsRepo),
    store,
  };
}

describe('MeetingAttendeesService', () => {
  it('invites a member by user id, lists them, then records their RSVP', async () => {
    const { service } = serviceWith({});
    const invited = await service.invite(context, member([PROJECT]), {
      meetingId: MEETING,
      userId: INVITEE,
    });
    expect(invited.userId).toBe(INVITEE);
    expect(invited.rsvp).toBe('invited');
    // The wire projection never echoes the tenant id or the internal membership id.
    expect(JSON.stringify(invited)).not.toContain(ORG);
    expect(JSON.stringify(invited)).not.toContain(MEMBERSHIP);

    const listed = await service.listAttendees(context, member([PROJECT]), { meetingId: MEETING });
    expect(listed.map((a) => a.id)).toEqual([invited.id]);

    // CQ-15 (COL-11): a response is the attendee's own, so the invited member — not the organiser —
    // records it. The caller's membership matches the attendee row's membership.
    const answered = await service.setRsvp(context, invitedMember(), {
      meetingId: MEETING,
      attendeeId: invited.id,
      rsvp: 'accepted',
    });
    expect(answered.rsvp).toBe('accepted');
  });

  it('refuses to set another member RSVP as forbidden, and writes nothing (CQ-15 COL-11)', async () => {
    const other = {
      id: 'attendee-0000-0000-0000-000000000020',
      organizationId: ORG,
      meetingId: MEETING,
      membershipId: MEMBERSHIP,
      rsvp: 'invited',
      createdAt: new Date(),
      userId: INVITEE,
    } as MeetingAttendeeRow & { userId: string };
    const { service } = serviceWith({ attendees: [other] });
    // The caller is an org-wide owner on the project (passes every relation gate), yet the attendee
    // row is someone else's membership — so it is a 403, not a silent write.
    const error = await service
      .setRsvp(context, member([PROJECT], true), {
        meetingId: MEETING,
        attendeeId: other.id,
        rsvp: 'accepted',
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect(other.rsvp).toBe('invited');
  });

  it('refuses to invite into a cross-tenant meeting as not-found, and writes nothing', async () => {
    // The meeting exists only in another tenant, so it does not resolve inside ORG → 404, before
    // any write. An org-wide caller (who would pass the relation gate) still gets not-found.
    const foreign = meetingRow({ id: MEETING, organizationId: OTHER_ORG });
    const { service, store } = serviceWith({ meetings: [foreign] });
    const error = await service
      .invite(context, member([], true), { meetingId: MEETING, userId: INVITEE })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(store).toHaveLength(0);
  });

  it('refuses an RSVP for an attendee of another meeting as not-found, and writes nothing', async () => {
    const attendee = {
      id: 'attendee-0000-0000-0000-000000000010',
      organizationId: ORG,
      meetingId: OTHER_MEETING,
      membershipId: MEMBERSHIP,
      rsvp: 'invited',
      createdAt: new Date(),
      userId: INVITEE,
    } as MeetingAttendeeRow & { userId: string };
    const { service } = serviceWith({
      meetings: [meetingRow({ id: MEETING }), meetingRow({ id: OTHER_MEETING })],
      attendees: [attendee],
    });
    const error = await service
      .setRsvp(context, member([PROJECT], true), {
        meetingId: MEETING,
        attendeeId: attendee.id,
        rsvp: 'accepted',
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    // The other meeting's attendee was untouched.
    expect(attendee.rsvp).toBe('invited');
  });
});

describe('MeetingAttendeesController', () => {
  it('rejects an illegal RSVP with 409 and never reaches the service', async () => {
    let called = false;
    const service = {
      setRsvp: async () => {
        called = true;
        return {} as never;
      },
    } as unknown as MeetingAttendeesService;
    const controller = new MeetingAttendeesController(service);

    const error = await controller
      .setRsvp(context, member([PROJECT]), MEETING, 'attendee-1', { rsvp: 'maybe' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect(called).toBe(false);
  });

  // The 403 boundary is the capability ceiling, not a handler check: assert the declared
  // capability and that it is held by every internal role that holds meeting.write and no client role.
  const invite = Reflect.getMetadata(
    REQUIRED_CAPABILITY,
    MeetingAttendeesController.prototype.invite,
  ) as Capability | undefined;
  const list = Reflect.getMetadata(
    REQUIRED_CAPABILITY,
    MeetingAttendeesController.prototype.list,
  ) as Capability | undefined;

  it('gates write on meeting.write and read on meeting.read', () => {
    expect(invite).toBe('meeting.write');
    expect(list).toBe('meeting.read');
  });

  it('closes the write to every client role (the 403 boundary)', () => {
    for (const role of INTERNAL_ROLES) {
      if (capabilitiesFor(role).includes('meeting.write')) {
        expect(capabilitiesFor(role)).toContain(invite);
      }
    }
    for (const role of CLIENT_ROLES) {
      expect(capabilitiesFor(role)).not.toContain(invite);
    }
  });
});
