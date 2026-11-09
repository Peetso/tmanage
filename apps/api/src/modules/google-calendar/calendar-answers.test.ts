import { describe, expect, it, vi } from 'vitest';
import { parseGoogleEvent } from './google-calendar.google.js';
import { GoogleCalendarService } from './google-calendar.service.js';
import { CalendarSyncJob, DEFAULT_CALENDAR_SYNC_JOB_OPTIONS } from './calendar-sync.job.js';
import type { CalendarProviderAdapter } from './calendar-sync.job.js';

/**
 * Fix 2026-11-09 (live): an answer given in Google Calendar never showed in TManage and nobody was
 * told. These pin the pull's answer rule (`provider-answers.ts`) through Google's "pull on open",
 * and the sync job's one-minute cadence with its per-connection backoff.
 */

const context = { organizationId: 'org_1', userId: 'user_1' } as never;
const ORG_ID = '01900000-0000-7000-8000-000000000001';

const organizerRow = {
  kind: 'member',
  id: 'att_org',
  userId: 'user_1',
  membershipId: 'm_1',
  displayName: 'Peter',
  email: 'peter@tmanage.app',
  optional: false,
  rsvp: 'accepted',
};
const memberRow = {
  kind: 'member',
  id: 'att_lina',
  userId: 'user_2',
  membershipId: 'm_2',
  displayName: 'Lina',
  email: 'lina@tmanage.app',
  optional: false,
  rsvp: 'invited',
};
const guestRow = {
  kind: 'guest',
  id: 'g_1',
  userId: null,
  membershipId: null,
  displayName: null,
  // Typed with capitals; Google reports addresses lowercased.
  email: 'Omar.Guest@Example.com',
  optional: false,
  rsvp: 'invited',
};

function harness(input: {
  attendees: Record<string, unknown>[];
  roster?: unknown[];
  ownRsvp?: Record<string, { response: string }>;
}) {
  const setRosterRsvp = vi.fn();
  const insert = vi.fn();
  const updateResponse = vi.fn();
  const append = vi.fn();
  const database = {
    read: (_c: unknown, f: (r: unknown) => unknown) => f({}),
    transaction: (_c: unknown, f: (r: unknown) => unknown) => f({}),
  };
  const svc = new GoogleCalendarService({
    database: database as never,
    audit: {} as never,
    transport: {
      refreshAccessToken: async () => ({ accessToken: 'at', expiresInSeconds: 3600 }),
      getEvent: async () =>
        parseGoogleEvent({ id: 'evt_1', status: 'confirmed', attendees: input.attendees }),
    } as never,
    cipher: { decrypt: () => 'rt', encrypt: () => 'enc' } as never,
    config: { clientId: 'c', clientSecret: 's' },
    apiPublicUrl: 'https://api',
    connections: {
      findById: async () => ({
        id: 'conn_1',
        userId: 'user_1',
        status: 'connected',
        refreshTokenEnc: 'enc',
        calendarId: 'primary',
      }),
    } as never,
    meetings: {
      findById: async () => ({
        id: 'mtg_1',
        projectId: 'proj_1',
        createdByUserId: 'user_1',
        updatedAt: new Date(),
        cancelledAt: null,
      }),
    } as never,
    calendar: {
      findLink: async () => ({
        id: 'link_1',
        meetingId: 'mtg_1',
        connectionId: 'conn_1',
        externalEventId: 'evt_1',
        externalCalendarId: 'primary',
        syncStatus: 'synced',
        lastPulledAt: null,
      }),
      roster: async () => input.roster ?? [organizerRow, memberRow, guestRow],
      setRosterRsvp,
      patchLink: vi.fn(),
    } as never,
    rsvps: {
      findByMember: async (_r: unknown, _c: unknown, _m: string, memberId: string) =>
        input.ownRsvp?.[memberId] ?? null,
      insert,
      updateResponse,
    } as never,
    outbox: { append } as never,
    log: () => undefined,
  });
  return { svc, setRosterRsvp, insert, updateResponse, append };
}

describe('answers given in Google Calendar (fix 2026-11-09)', () => {
  it('a guest’s Yes lands on their row, whatever the case of the typed address, and the organizer is told', async () => {
    const { svc, setRosterRsvp, append } = harness({
      attendees: [{ email: 'omar.guest@example.com', responseStatus: 'accepted' }],
    });
    await svc.pullMeeting(context, 'mtg_1', 0);
    expect(setRosterRsvp).toHaveBeenCalledWith({}, context, guestRow, 'mtg_1', 'accepted');
    expect(append).toHaveBeenCalledWith({}, context, {
      type: 'meeting.attendee_responded.v1',
      aggregateId: 'mtg_1',
      payload: {
        meetingId: 'mtg_1',
        projectId: 'proj_1',
        attendeeKind: 'guest',
        attendeeId: 'g_1',
        attendeeUserId: null,
        response: 'accepted',
        provider: 'google',
      },
    });
  });

  it('the organizer’s own Maybe (their calendar’s `self` entry) is applied, to the roster and to “Are you going?”, without telling themselves', async () => {
    const { svc, setRosterRsvp, insert, append } = harness({
      // The organizer's Google address differs from their TManage sign-in address.
      attendees: [
        { email: 'peter@gmail.com', self: true, organizer: true, responseStatus: 'tentative' },
      ],
    });
    await svc.pullMeeting(context, 'mtg_1', 0);
    expect(setRosterRsvp).toHaveBeenCalledWith({}, context, organizerRow, 'mtg_1', 'tentative');
    expect(insert).toHaveBeenCalledWith({}, context, {
      meetingId: 'mtg_1',
      memberId: 'm_1',
      response: 'tentative',
    });
    expect(append).not.toHaveBeenCalled();
  });

  it('never downgrades the organizer to “not answered” because Google says needsAction', async () => {
    const { svc, setRosterRsvp, insert } = harness({
      attendees: [{ email: 'peter@tmanage.app', responseStatus: 'needsAction' }],
    });
    await svc.pullMeeting(context, 'mtg_1', 0);
    expect(setRosterRsvp).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it('a member’s Yes from Google is written to meeting_rsvps too, so “Are you going?” and the counts agree', async () => {
    const { svc, setRosterRsvp, insert, append } = harness({
      attendees: [{ email: 'lina@tmanage.app', responseStatus: 'accepted' }],
    });
    await svc.pullMeeting(context, 'mtg_1', 0);
    expect(setRosterRsvp).toHaveBeenCalledWith({}, context, memberRow, 'mtg_1', 'accepted');
    expect(insert).toHaveBeenCalledWith({}, context, {
      meetingId: 'mtg_1',
      memberId: 'm_2',
      response: 'accepted',
    });
    expect(append).toHaveBeenCalledWith(
      {},
      context,
      expect.objectContaining({
        payload: expect.objectContaining({ attendeeUserId: 'user_2', attendeeKind: 'member' }),
      }),
    );
  });

  it('an answer the member already gave in TManage is not news, and a stale Google copy never overwrites one', async () => {
    const answeredHere = harness({
      attendees: [{ email: 'lina@tmanage.app', responseStatus: 'accepted' }],
      ownRsvp: { m_2: { response: 'accepted' } },
    });
    await answeredHere.svc.pullMeeting(context, 'mtg_1', 0);
    expect(answeredHere.append).not.toHaveBeenCalled();
    expect(answeredHere.insert).not.toHaveBeenCalled();

    // The roster already says accepted (unchanged in Google); TManage now says No.
    const stale = harness({
      attendees: [{ email: 'lina@tmanage.app', responseStatus: 'accepted' }],
      roster: [{ ...memberRow, rsvp: 'accepted' }],
      ownRsvp: { m_2: { response: 'declined' } },
    });
    await stale.svc.pullMeeting(context, 'mtg_1', 0);
    expect(stale.updateResponse).not.toHaveBeenCalled();
    expect(stale.setRosterRsvp).not.toHaveBeenCalled();
  });
});

describe('the calendar sync job cadence (fix 2026-11-09)', () => {
  it('pulls every minute, starting ten seconds after boot', () => {
    expect(DEFAULT_CALENDAR_SYNC_JOB_OPTIONS.intervalMs).toBe(60_000);
    expect(DEFAULT_CALENDAR_SYNC_JOB_OPTIONS.bootDelayMs).toBeLessThanOrEqual(10_000);
  });

  it('backs a failing connection off (doubling, capped) without holding up the others', async () => {
    let now = 0;
    const refs = [
      { id: 'bad', organizationId: ORG_ID, provider: 'google' },
      { id: 'good', organizationId: ORG_ID, provider: 'google' },
    ];
    const calls: string[] = [];
    const adapter: CalendarProviderAdapter = {
      provider: 'google',
      pullConnection: async (_c, id) => {
        calls.push(id);
        return id === 'bad' ? 'failed' : 'ok';
      },
    };
    const job = new CalendarSyncJob(
      { bootstrapRead: (_o: unknown, f: (db: unknown) => unknown) => f({}) } as never,
      [adapter],
      false,
      {
        bootDelayMs: 0,
        intervalMs: 60_000,
        maxBackoffMs: 300_000,
        log: () => undefined,
        now: () => now,
      },
      { connectedAcrossOrganizations: async () => refs } as never,
    );
    await job.runOnce(); // bad fails → waits 2 min
    now = 60_000;
    await job.runOnce(); // bad still waiting
    now = 120_000;
    await job.runOnce(); // bad retried, fails again → waits 4 min
    now = 300_000;
    await job.runOnce(); // still waiting (until 360 000)
    now = 360_000;
    await job.runOnce();
    expect(calls.filter((id) => id === 'good')).toHaveLength(5);
    expect(calls.filter((id) => id === 'bad')).toHaveLength(3);
  });
});
