import { describe, expect, it, vi } from 'vitest';
import type { MeetingSnapshot } from '../google-calendar/google-calendar.google.js';
import { combineCalendarSync, pushProviderFor } from '../calendar/calendar-provider.js';
import {
  MicrosoftCalendarGrantRevokedError,
  createMicrosoftCalendarTransport,
  fromGraphRecurrence,
  isPersonalMicrosoftAccount,
  localDateTime,
  microsoftCalendarAuthorizationUrl,
  microsoftCalendarConfigFrom,
  newMicrosoftCalendarFlow,
  openMicrosoftCalendarFlow,
  parseGraphEvent,
  rsvpFromGraph,
  sealMicrosoftCalendarFlow,
  toGraphEvent,
  toGraphRecurrence,
} from './microsoft-calendar.graph.js';
import { microsoftCalendarCallbackTarget } from './microsoft-calendar.controller.js';
import { MicrosoftCalendarService, withoutTeamsBlock } from './microsoft-calendar.service.js';

const SECRET = 'a-session-secret-long-enough-for-the-flow-cookie-000';
const owner = { organizationId: 'org_1', organizationSlug: 'northstar', userId: 'user_1' };
const config = { clientId: 'c', clientSecret: 's', tenant: 'common' };

const snapshot: MeetingSnapshot = {
  id: 'mtg_1',
  title: 'Review',
  agendaNote: 'Agenda',
  startsAt: new Date('2026-11-02T08:30:00.000Z'),
  endsAt: null,
  allDay: false,
  timeZone: 'Africa/Cairo',
  location: 'Room 4',
  recurrenceRrule: 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6',
  visibility: 'private',
  showAs: 'free',
  colorId: '5',
  conference: 'teams',
  reminders: [
    { method: 'popup', minutes: 15 },
    { method: 'email', minutes: 1440 },
  ],
  guestsCanModify: true,
  guestsCanInviteOthers: true,
  guestsCanSeeOthers: false,
  cancelled: false,
  attendees: [
    { email: 'guest@example.com', optional: true, displayName: null },
    { email: 'sam@example.com', optional: false, displayName: 'Sam' },
  ],
  attachments: [],
};

describe('Outlook calendar protocol (0237 slice B)', () => {
  it('reuses the OneDrive app registration', () => {
    expect(microsoftCalendarConfigFrom({})).toBeNull();
    expect(
      microsoftCalendarConfigFrom({ MICROSOFT_CLIENT_ID: 'a', MICROSOFT_CLIENT_SECRET: 'b' }),
    ).toEqual({ clientId: 'a', clientSecret: 'b', tenant: 'common' });
  });

  it('seals the flow under its own purpose; forged or expired cookies are refused', () => {
    const flow = newMicrosoftCalendarFlow(owner, 1000);
    const sealed = sealMicrosoftCalendarFlow(flow, SECRET);
    expect(openMicrosoftCalendarFlow(sealed, SECRET, 1001)?.state).toBe(flow.state);
    expect(openMicrosoftCalendarFlow(`${sealed}x`, SECRET, 1001)).toBeUndefined();
    expect(openMicrosoftCalendarFlow(sealed, SECRET, 1000 + 601)).toBeUndefined();
  });

  it('asks for Calendars.ReadWrite with PKCE, never OnlineMeetings', () => {
    const url = new URL(
      microsoftCalendarAuthorizationUrl({
        config,
        redirectUri: 'https://x/cb',
        flow: newMicrosoftCalendarFlow(owner),
      }),
    );
    expect(url.origin + url.pathname).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    );
    expect(url.searchParams.get('scope')).toBe(
      'openid profile email offline_access Calendars.ReadWrite',
    );
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('forwards the code in the fragment to Connected apps', () => {
    const cookie = `tm_mscal_flow=${sealMicrosoftCalendarFlow(newMicrosoftCalendarFlow(owner), SECRET)}`;
    const options = { sessionSecret: SECRET, webPublicUrl: 'https://app.example/' };
    expect(microsoftCalendarCallbackTarget(options, cookie, 'c1', 's1')).toBe(
      'https://app.example/northstar/settings/connected-apps#mscal=complete&code=c1&state=s1',
    );
    expect(microsoftCalendarCallbackTarget(options, cookie, undefined, 's1')).toBe(
      'https://app.example/northstar/settings/connected-apps#mscal=error',
    );
    expect(microsoftCalendarCallbackTarget(options, undefined, 'c1', 's1')).toBe(
      'https://app.example/',
    );
  });
});

describe('RRULE <-> Graph recurrence', () => {
  const start = new Date('2026-11-02T08:30:00.000Z'); // a Monday in Cairo
  it.each([
    [
      'FREQ=DAILY;INTERVAL=2;COUNT=5',
      { type: 'daily', interval: 2 },
      { type: 'numbered', numberOfOccurrences: 5 },
    ],
    [
      'FREQ=WEEKLY;BYDAY=MO,WE;WKST=SU',
      {
        type: 'weekly',
        interval: 1,
        daysOfWeek: ['monday', 'wednesday'],
        firstDayOfWeek: 'sunday',
      },
      { type: 'noEnd' },
    ],
    [
      'FREQ=WEEKLY;UNTIL=20261231T215959Z',
      { type: 'weekly', daysOfWeek: ['monday'] },
      { type: 'endDate', endDate: '2026-12-31' },
    ],
    ['FREQ=MONTHLY;BYMONTHDAY=15', { type: 'absoluteMonthly', dayOfMonth: 15 }, { type: 'noEnd' }],
    [
      'FREQ=MONTHLY;BYDAY=-1FR',
      { type: 'relativeMonthly', daysOfWeek: ['friday'], index: 'last' },
      { type: 'noEnd' },
    ],
    ['FREQ=YEARLY', { type: 'absoluteYearly', month: 11, dayOfMonth: 2 }, { type: 'noEnd' }],
    [
      'FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR',
      { type: 'weekly', daysOfWeek: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] },
      { type: 'noEnd' },
    ],
  ])('%s', (rrule, pattern, range) => {
    const out = toGraphRecurrence(rrule, start, 'Africa/Cairo');
    expect(out?.pattern).toMatchObject(pattern);
    expect(out?.range).toMatchObject({
      ...range,
      startDate: '2026-11-02',
      recurrenceTimeZone: 'Africa/Cairo',
    });
  });

  it('refuses what Outlook cannot say', () => {
    for (const rrule of [
      'FREQ=MONTHLY;BYMONTHDAY=1,15',
      'FREQ=MONTHLY;BYDAY=1MO,-1FR',
      'FREQ=MONTHLY;BYDAY=MO',
      'FREQ=MONTHLY;BYDAY=5MO',
      'FREQ=WEEKLY;BYSETPOS=1',
      'FREQ=HOURLY',
      'FREQ=WEEKLY;BYMONTHDAY=3',
    ]) {
      expect(toGraphRecurrence(rrule, start, 'UTC'), rrule).toBeNull();
    }
  });

  it('reads Graph recurrence back as the same RRULE', () => {
    for (const rrule of [
      'FREQ=DAILY;INTERVAL=2;COUNT=5',
      'FREQ=WEEKLY;BYDAY=MO,WE',
      'FREQ=MONTHLY;BYMONTHDAY=15',
      'FREQ=MONTHLY;BYDAY=-1FR',
      'FREQ=YEARLY;BYMONTH=3;BYDAY=2TU',
    ]) {
      expect(fromGraphRecurrence(toGraphRecurrence(rrule, start, 'UTC'))).toBe(rrule);
    }
    expect(
      fromGraphRecurrence({
        pattern: { type: 'weekly', interval: 1, daysOfWeek: ['friday'] },
        range: { type: 'endDate', startDate: '2026-11-06', endDate: '2027-01-29' },
      }),
    ).toBe('FREQ=WEEKLY;BYDAY=FR;UNTIL=20270129');
  });
});

describe('TManage meeting -> Graph event', () => {
  it('maps every option, Teams for a work account', () => {
    const body = toGraphEvent(snapshot, { personalAccount: false });
    expect(body).toMatchObject({
      subject: 'Review',
      body: { contentType: 'text', content: 'Agenda' },
      start: { dateTime: '2026-11-02T10:30:00', timeZone: 'Africa/Cairo' },
      end: { dateTime: '2026-11-02T11:00:00', timeZone: 'Africa/Cairo' },
      location: { displayName: 'Room 4' },
      attendees: [
        { emailAddress: { address: 'guest@example.com' }, type: 'optional' },
        { emailAddress: { address: 'sam@example.com', name: 'Sam' }, type: 'required' },
      ],
      showAs: 'free',
      sensitivity: 'private',
      hideAttendees: true,
      allowNewTimeProposals: true,
      categories: ['Banana'],
      isReminderOn: true,
      reminderMinutesBeforeStart: 15,
      isOnlineMeeting: true,
      onlineMeetingProvider: 'teamsForBusiness',
      recurrence: { pattern: { type: 'weekly' }, range: { type: 'numbered' } },
    });
  });

  it('a personal account gets the mailbox default; all-day ends the next midnight', () => {
    const body = toGraphEvent(
      { ...snapshot, allDay: true, reminders: [], recurrenceRrule: null, visibility: 'public' },
      { personalAccount: true },
    );
    expect(body).not.toHaveProperty('onlineMeetingProvider');
    expect(body).toMatchObject({
      isAllDay: true,
      start: { dateTime: '2026-11-02T00:00:00' },
      end: { dateTime: '2026-11-03T00:00:00' },
      isReminderOn: false,
      sensitivity: 'normal',
      recurrence: null,
    });
    expect(isPersonalMicrosoftAccount('maya@outlook.com')).toBe(true);
    expect(isPersonalMicrosoftAccount('maya@contoso.com')).toBe(false);
  });

  it('refuses a recurrence Outlook cannot say instead of half-sending it', () => {
    expect(() =>
      toGraphEvent(
        { ...snapshot, recurrenceRrule: 'FREQ=MONTHLY;BYMONTHDAY=1,15' },
        {
          personalAccount: false,
        },
      ),
    ).toThrow(/Outlook cannot repeat/);
  });

  it('reads the Teams link and answers back, https only, times in UTC', () => {
    const event = parseGraphEvent({
      id: 'e1',
      webLink: 'javascript:alert(1)',
      onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/x' },
      start: { dateTime: '2026-11-02T08:30:00.0000000', timeZone: 'UTC' },
      attendees: [
        { emailAddress: { address: 'A@B.co' }, status: { response: 'tentativelyAccepted' } },
      ],
    });
    expect(event.joinUrl).toBe('https://teams.microsoft.com/l/meetup-join/x');
    expect(event.webLink).toBeNull();
    expect(event.startsAt?.toISOString()).toBe('2026-11-02T08:30:00.000Z');
    expect(rsvpFromGraph(event.attendees[0]?.response ?? '')).toBe('tentative');
    expect(rsvpFromGraph('notResponded')).toBe('invited');
    expect(localDateTime(new Date('2026-11-02T22:30:00.000Z'), 'Africa/Cairo')).toBe(
      '2026-11-03T00:30:00',
    );
    expect(withoutTeamsBlock('Agenda\n\n________________\nMicrosoft Teams meeting')).toBe('Agenda');
  });

  it('a refused refresh token is a revoked grant', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"invalid_grant"}', { status: 400 }));
    const transport = createMicrosoftCalendarTransport(fetchImpl as never);
    await expect(transport.refreshTokens({ config, refreshToken: 'rt' })).rejects.toBeInstanceOf(
      MicrosoftCalendarGrantRevokedError,
    );
  });
});

describe('one calendar per meeting', () => {
  const base = {
    conference: 'none',
    googleConnected: true,
    microsoftConnected: true,
    googleLinked: false,
    microsoftLinked: false,
  };
  it('picks exactly one provider', () => {
    expect(pushProviderFor(base)).toBe('google');
    expect(pushProviderFor({ ...base, conference: 'teams' })).toBe('microsoft');
    expect(pushProviderFor({ ...base, conference: 'teams', googleLinked: true })).toBe('google');
    expect(pushProviderFor({ ...base, microsoftLinked: true })).toBe('microsoft');
    expect(pushProviderFor({ ...base, conference: 'google_meet', googleConnected: false })).toBe(
      'microsoft',
    );
    expect(pushProviderFor({ ...base, googleConnected: false, microsoftConnected: false })).toBe(
      null,
    );
  });

  it('the combined port calls every provider', async () => {
    const a = { pushMeeting: vi.fn(), forwardRsvp: vi.fn(), pullMeeting: vi.fn() };
    const b = { pushMeeting: vi.fn(), forwardRsvp: vi.fn(), pullMeeting: vi.fn() };
    const port = combineCalendarSync([a, undefined, b]);
    await port.pushMeeting({} as never, 'm');
    await port.pullMeeting({} as never, 'm', 0);
    expect(a.pushMeeting).toHaveBeenCalledOnce();
    expect(b.pushMeeting).toHaveBeenCalledOnce();
    expect(b.pullMeeting).toHaveBeenCalledWith({}, 'm', 0);
  });
});

describe('MicrosoftCalendarService', () => {
  const context = { organizationId: 'org_1', userId: 'user_1' } as never;
  const live = {
    id: 'conn_1',
    userId: 'user_1',
    status: 'connected',
    refreshTokenEnc: 'enc_old',
    calendarId: 'primary',
    accountEmail: 'maya@contoso.com',
    syncCursor: null,
  };
  const graphEvent = (over: Record<string, unknown> = {}) =>
    parseGraphEvent({
      id: 'evt_1',
      iCalUId: 'uid_1',
      changeKey: 'ck',
      webLink: 'https://outlook.office.com/calendar/item/1',
      onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/1' },
      ...over,
    });
  function service(input: {
    meeting?: Record<string, unknown>;
    connections?: Record<string, unknown>;
    links?: Record<string, unknown>;
    transport: Record<string, unknown>;
    roster?: unknown[];
  }) {
    const update = vi.fn();
    const saveLink = vi.fn();
    const patchLink = vi.fn();
    const setRosterRsvp = vi.fn();
    const meetingUpdate = vi.fn();
    const database = {
      read: (_c: unknown, f: (r: unknown) => unknown) => f({}),
      transaction: (_c: unknown, f: (r: unknown) => unknown) => f({}),
    };
    const meeting = {
      id: 'mtg_1',
      title: 'Review',
      agendaNote: null,
      startsAt: new Date('2026-11-02T08:30:00.000Z'),
      endsAt: null,
      allDay: false,
      timeZone: null,
      location: null,
      recurrenceRrule: null,
      visibility: 'default',
      showAs: 'busy',
      colorId: null,
      conference: 'teams',
      reminders: null,
      guestsCanModify: false,
      guestsCanInviteOthers: true,
      guestsCanSeeOthers: true,
      createdByUserId: 'user_1',
      updatedAt: new Date('2026-10-01T00:00:00.000Z'),
      cancelledAt: null,
      ...input.meeting,
    };
    const svc = new MicrosoftCalendarService({
      database: database as never,
      audit: { record: vi.fn() } as never,
      transport: {
        refreshTokens: async () => ({
          accessToken: 'at',
          refreshToken: 'rt_new',
          expiresInSeconds: 3600,
          email: null,
          scope: null,
        }),
        ...input.transport,
      } as never,
      cipher: { decrypt: () => 'rt_old', encrypt: (v: string) => `enc(${v})` } as never,
      config,
      apiPublicUrl: 'https://api',
      googleConfigured: true,
      connections: {
        findFor: async (_r: unknown, _c: unknown, userId: string, provider: string) =>
          input.connections?.[`${userId}:${provider}`] ?? null,
        findById: async () => live,
        userEmail: async () => 'maya@contoso.com',
        update,
      } as never,
      meetings: { findById: async () => meeting, update: meetingUpdate } as never,
      calendar: {
        findLink: async (_r: unknown, _c: unknown, _m: string, provider: string) =>
          input.links?.[provider] ?? null,
        findLinkByEvent: async (_r: unknown, _c: unknown, _conn: string, id: string) =>
          id === 'evt_1' ? (input.links?.['microsoft'] ?? null) : null,
        roster: async () => input.roster ?? [],
        listAttachments: async () => [],
        saveLink,
        patchLink,
        setRosterRsvp,
      } as never,
      log: () => undefined,
    });
    return { svc, update, saveLink, patchLink, setRosterRsvp, meetingUpdate };
  }

  it('creates a Teams meeting idempotently and stores the rotated refresh token', async () => {
    const createEvent = vi.fn(async () => graphEvent());
    const { svc, update, saveLink } = service({
      connections: { 'user_1:microsoft': { ...live } },
      transport: { createEvent },
    });
    await svc.pushMeeting(context, 'mtg_1');
    expect(createEvent).toHaveBeenCalledWith(
      'at',
      expect.objectContaining({ isOnlineMeeting: true, transactionId: 'mtg_1' }),
    );
    expect(update).toHaveBeenCalledWith({}, context, 'conn_1', {
      refreshTokenEnc: 'enc(rt_new)',
    });
    expect(saveLink).toHaveBeenCalledWith(
      {},
      context,
      'mtg_1',
      'microsoft',
      expect.objectContaining({
        externalEventId: 'evt_1',
        icalUid: 'uid_1',
        joinUrl: 'https://teams.microsoft.com/l/meetup-join/1',
        syncStatus: 'synced',
        lastErrorCode: null,
      }),
    );
  });

  it('leaves a meeting already in Google to Google', async () => {
    const createEvent = vi.fn();
    const { svc, saveLink } = service({
      connections: {
        'user_1:microsoft': { ...live },
        'user_1:google': { ...live, id: 'g' },
      },
      links: { google: { id: 'l', externalEventId: 'gevt', syncStatus: 'synced' } },
      transport: { createEvent },
    });
    await svc.pushMeeting(context, 'mtg_1');
    expect(createEvent).not.toHaveBeenCalled();
    expect(saveLink).not.toHaveBeenCalled();
  });

  it('a repeat Outlook cannot say is an error on the link, nothing is sent', async () => {
    const createEvent = vi.fn();
    const { svc, saveLink } = service({
      meeting: { recurrenceRrule: 'FREQ=MONTHLY;BYMONTHDAY=1,15' },
      connections: { 'user_1:microsoft': { ...live } },
      transport: { createEvent },
    });
    await expect(svc.pushMeeting(context, 'mtg_1')).resolves.toBeUndefined();
    expect(createEvent).not.toHaveBeenCalled();
    expect(saveLink).toHaveBeenCalledWith({}, context, 'mtg_1', 'microsoft', {
      connectionId: 'conn_1',
      syncStatus: 'error',
      lastErrorCode: 'recurrence_unsupported',
    });
  });

  it('a cancelled meeting is cancelled in Outlook', async () => {
    const cancelEvent = vi.fn();
    const link = {
      id: 'l1',
      externalEventId: 'evt_1',
      syncStatus: 'synced',
      connectionId: 'conn_1',
    };
    const { svc, patchLink } = service({
      meeting: { cancelledAt: new Date() },
      connections: { 'user_1:microsoft': { ...live } },
      links: { microsoft: link },
      transport: { cancelEvent },
    });
    await svc.pushMeeting(context, 'mtg_1');
    expect(cancelEvent).toHaveBeenCalledWith('at', 'evt_1');
    expect(patchLink).toHaveBeenCalledWith(
      {},
      context,
      'l1',
      expect.objectContaining({ syncStatus: 'deleted' }),
    );
  });

  it('an answer goes through the person’s own Outlook copy', async () => {
    const respond = vi.fn();
    const findByICalUid = vi.fn(async () => graphEvent({ id: 'copy_9' }));
    const link = {
      id: 'l1',
      externalEventId: 'evt_1',
      icalUid: 'uid_1',
      syncStatus: 'synced',
      connectionId: 'conn_1',
    };
    const { svc } = service({
      connections: { 'user_2:microsoft': { ...live, id: 'conn_2', userId: 'user_2' } },
      links: { microsoft: link },
      transport: { respond, findByICalUid },
    });
    await svc.forwardRsvp(context, 'mtg_1', 'user_2', 'tentative');
    expect(findByICalUid).toHaveBeenCalledWith('at', 'uid_1');
    expect(respond).toHaveBeenCalledWith('at', 'copy_9', 'tentativelyAccept');
  });

  it('the delta pass pulls answers onto the roster and stores the delta link', async () => {
    const link = {
      id: 'l1',
      meetingId: 'mtg_1',
      externalEventId: 'evt_1',
      syncStatus: 'synced',
      connectionId: 'conn_1',
    };
    const delta = vi.fn(async () => ({
      events: [graphEvent({ id: 'evt_1' }), graphEvent({ id: 'other' })],
      nextLink: null,
      deltaLink: 'https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=t2',
    }));
    const getEvent = vi.fn(async () =>
      graphEvent({
        attendees: [
          { emailAddress: { address: 'Guest@Example.com' }, status: { response: 'accepted' } },
        ],
      }),
    );
    const entry = {
      kind: 'guest',
      id: 'g1',
      userId: null,
      displayName: null,
      email: 'guest@example.com',
      optional: false,
      rsvp: 'invited',
    };
    const { svc, update, setRosterRsvp } = service({
      links: { microsoft: link },
      transport: { delta, getEvent },
      roster: [entry],
    });
    await svc.pullConnection(context, 'conn_1');
    expect(getEvent).toHaveBeenCalledOnce();
    expect(setRosterRsvp).toHaveBeenCalledWith({}, context, entry, 'mtg_1', 'accepted');
    expect(update).toHaveBeenCalledWith(
      {},
      context,
      'conn_1',
      expect.objectContaining({
        syncCursor: 'https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=t2',
      }),
    );
  });
});
