import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { MeetingRow } from '../../common/database/schema.js';
import { MeetingAttendeesService } from './meeting-attendees.service.js';
import type { MeetingAttendeesRepository } from './meeting-attendees.repository.js';
import type { MeetingsRepository } from './meetings.repository.js';
import type { MembershipsRepository } from '../tenancy/memberships.repository.js';
import type {
  ClientAttendeeWithPerson,
  ClientCandidateRow,
  ClientMeetingRow,
  MeetingClientAttendeesRepository,
} from './meeting-client-attendees.repository.js';
import { MeetingsService, meetingChangedFields } from './meetings.service.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import { PortalMeetingsService } from './portal-meetings.service.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';

/**
 * BK5 (0217) — client people as meeting attendees, the portal's "only my meetings", and the
 * "meeting changed" notice, database-free over fakes. The SQL predicates (project's client
 * companies, the caller's own client membership) are the repository's; here the subject is the
 * services' decisions and what they hand the outbox.
 */

const ORG = 'org-1';
const PROJECT = 'proj-1';
const MEETING = 'mtg-1';
const USER = 'maya';

const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

const staff: Principal = {
  userId: USER,
  organizationId: ORG,
  kind: 'internal',
  role: 'member',
  membershipId: 'm-maya',
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [PROJECT],
  hasOrgWideScope: false,
};

const client = (membershipId: string): Principal => ({
  userId: `user-${membershipId}`,
  organizationId: ORG,
  kind: 'client',
  role: 'client_member',
  membershipId,
  membershipStatus: 'active',
  clientOrganizationId: 'co-atlas',
  projectIds: [PROJECT],
  hasOrgWideScope: false,
});

const meeting: MeetingRow = {
  id: MEETING,
  organizationId: ORG,
  projectId: PROJECT,
  title: 'Weekly client review',
  startsAt: new Date('2026-10-29T10:00:00.000Z'),
  endsAt: new Date('2026-10-29T11:00:00.000Z'),
  agendaNote: 'internal prep',
  createdByUserId: USER,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const database = {
  read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
} as unknown as TenantDatabase;

/** Salma (co-atlas) is a client of the project; nobody else is. */
const SALMA: ClientCandidateRow = {
  clientMembershipId: 'cm-salma',
  userId: 'salma',
  displayName: 'Salma Riad',
  clientOrganizationId: 'co-atlas',
  clientOrganizationName: 'Atlas Hospitality',
};

function rosterFake(): {
  roster: MeetingClientAttendeesRepository;
  rows: ClientAttendeeWithPerson[];
  rsvps: string[];
} {
  const rows: ClientAttendeeWithPerson[] = [];
  const rsvps: string[] = [];
  const roster = {
    listCandidates: async (_r: unknown, _c: unknown, projectId: string, userId?: string) =>
      projectId === PROJECT && (userId === undefined || userId === SALMA.userId) ? [SALMA] : [],
    findByClientMembership: async (_r: unknown, _c: unknown, meetingId: string, cm: string) =>
      rows.find((row) => row.meetingId === meetingId && row.clientMembershipId === cm) ?? null,
    findById: async (_r: unknown, _c: unknown, id: string) =>
      rows.find((row) => row.id === id) ?? null,
    invite: async (
      _r: unknown,
      _c: unknown,
      input: { meetingId: string; clientMembershipId: string },
    ) => {
      const row: ClientAttendeeWithPerson = {
        ...SALMA,
        id: `mca-${rows.length + 1}`,
        meetingId: input.meetingId,
        clientMembershipId: input.clientMembershipId,
        rsvp: 'invited',
        createdAt: new Date(),
      };
      rows.push(row);
      return row;
    },
    remove: async (_r: unknown, _c: unknown, _m: string, id: string) => {
      rows.splice(
        rows.findIndex((row) => row.id === id),
        1,
      );
    },
    listForMeeting: async () => rows,
    listMemberUserIds: async () => ['maya', 'lina'],
    listMemberNames: async () => [{ userId: 'maya', displayName: 'Maya Hassan', rsvp: 'accepted' }],
    listForClient: async (
      _r: unknown,
      _c: unknown,
      input: { clientMembershipId: string; meetingId?: string },
    ): Promise<ClientMeetingRow[]> =>
      rows
        .filter(
          (row) =>
            row.clientMembershipId === input.clientMembershipId &&
            (input.meetingId === undefined || row.meetingId === input.meetingId),
        )
        .map((row) => ({ meeting, attendeeId: row.id, rsvp: row.rsvp })),
    setRsvp: async (_r: unknown, _c: unknown, _m: string, _id: string, rsvp: string) => {
      rsvps.push(rsvp);
    },
  } as unknown as MeetingClientAttendeesRepository;
  return { roster, rows, rsvps };
}

function outboxFake(): {
  outbox: OutboxEventsRepository;
  events: { type: string; payload: unknown }[];
} {
  const events: { type: string; payload: unknown }[] = [];
  const outbox = {
    append: async (_tx: unknown, _c: unknown, e: { type: string; payload: unknown }) => {
      events.push(e);
    },
  } as unknown as OutboxEventsRepository;
  return { outbox, events };
}

function attendeesService() {
  const { roster, rows } = rosterFake();
  const { outbox, events } = outboxFake();
  const memberRoster = {
    findById: async () => null,
  } as unknown as MeetingAttendeesRepository;
  const meetings = {
    findById: async (_r: unknown, _c: unknown, id: string) => (id === MEETING ? meeting : null),
  } as unknown as MeetingsRepository;
  const service = new MeetingAttendeesService(
    database,
    memberRoster,
    meetings,
    {} as MembershipsRepository,
    outbox,
    roster,
  );
  return { service, rows, events };
}

describe('client attendees (BK5)', () => {
  it('adds a client of the project company and sends them the invite notice, marked client', async () => {
    const { service, rows, events } = attendeesService();
    const view = await service.inviteClient(context, staff, {
      meetingId: MEETING,
      userId: 'salma',
    });
    expect(view).toMatchObject({ userId: 'salma', clientOrganizationName: 'Atlas Hospitality' });
    expect(rows).toHaveLength(1);
    expect(events).toEqual([
      {
        type: 'meeting.attendee_invited.v1',
        aggregateId: MEETING,
        payload: expect.objectContaining({
          attendeeUserId: 'salma',
          attendeeKind: 'client',
          clientOrganizationId: 'co-atlas',
        }),
      },
    ]);
  });

  it('refuses a client of another company with a 400 and writes nothing', async () => {
    const { service, rows, events } = attendeesService();
    const error = await service
      .inviteClient(context, staff, { meetingId: MEETING, userId: 'youssef-other-co' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect(rows).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it('removes a client attendee through the attendee DELETE', async () => {
    const { service, rows } = attendeesService();
    const view = await service.inviteClient(context, staff, {
      meetingId: MEETING,
      userId: 'salma',
    });
    await service.remove(context, staff, { meetingId: MEETING, attendeeId: view.id });
    expect(rows).toHaveLength(0);
  });
});

describe('portal meetings (BK5)', () => {
  it('shows a client only the meetings they attend, and nothing to an internal caller', async () => {
    const { roster, rows } = rosterFake();
    rows.push({
      ...SALMA,
      id: 'mca-1',
      meetingId: MEETING,
      rsvp: 'invited',
      createdAt: new Date(),
    });
    const portal = new PortalMeetingsService(database, roster);

    const mine = await portal.list(context, client('cm-salma'));
    expect(mine.map((m) => m.id)).toEqual([MEETING]);
    expect(JSON.stringify(mine)).not.toContain('internal prep'); // no agenda note
    expect(await portal.list(context, client('cm-someone-else'))).toEqual([]);
    expect(await portal.list(context, staff)).toEqual([]);

    const notMine = await portal.get(context, client('cm-someone-else'), MEETING).catch((e) => e);
    expect((notMine as ApiError).status).toBe(404);
  });

  it('lets a client answer their own invite', async () => {
    const { roster, rows, rsvps } = rosterFake();
    rows.push({
      ...SALMA,
      id: 'mca-1',
      meetingId: MEETING,
      rsvp: 'invited',
      createdAt: new Date(),
    });
    const portal = new PortalMeetingsService(database, roster);
    const view = await portal.setRsvp(context, client('cm-salma'), MEETING, 'accepted');
    expect(view.rsvp).toBe('accepted');
    expect(rsvps).toEqual(['accepted']);
  });
});

describe('meeting changed notice (BK5)', () => {
  function meetingsService() {
    const store = { ...meeting };
    const { roster, rows } = rosterFake();
    rows.push({
      ...SALMA,
      id: 'mca-1',
      meetingId: MEETING,
      rsvp: 'invited',
      createdAt: new Date(),
    });
    const { outbox, events } = outboxFake();
    const repository = {
      findById: async () => store,
      update: async (_r: unknown, _c: unknown, _id: string, input: Partial<MeetingRow>) =>
        Object.assign(store, input),
    } as unknown as MeetingsRepository;
    const service = new MeetingsService(
      database,
      repository,
      {} as ProjectsRepository,
      undefined,
      outbox,
      undefined,
      undefined,
      roster,
    );
    return { service, events };
  }

  it('tells the attendees at that moment when the time moves, naming what changed', async () => {
    const { service, events } = meetingsService();
    await service.update(context, staff, MEETING, {
      startsAt: new Date('2026-10-30T10:00:00.000Z'),
      endsAt: new Date('2026-10-30T11:00:00.000Z'),
    });
    expect(events).toEqual([
      {
        type: 'meeting.changed.v1',
        aggregateId: MEETING,
        payload: {
          meetingId: MEETING,
          projectId: PROJECT,
          changedByUserId: USER,
          changedFields: ['startsAt', 'endsAt'],
          memberUserIds: ['maya', 'lina'],
          clientAttendees: [{ userId: 'salma', clientOrganizationId: 'co-atlas' }],
        },
      },
    ]);
  });

  it('is silent for an agenda-only edit or a re-sent unchanged title', async () => {
    const { service, events } = meetingsService();
    await service.update(context, staff, MEETING, { agendaNote: 'new', title: meeting.title });
    expect(events).toEqual([]);
    expect(meetingChangedFields(meeting, { title: 'Renamed', endsAt: null })).toEqual([
      'title',
      'endsAt',
    ]);
  });
});
