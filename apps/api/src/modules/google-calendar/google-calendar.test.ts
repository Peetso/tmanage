import { describe, expect, it, vi } from 'vitest';
import {
  calendarAuthorizationUrl,
  calendarConfigFrom,
  newCalendarFlow,
  openCalendarFlow,
  parseGoogleEvent,
  rsvpFromGoogle,
  sealCalendarFlow,
  toGoogleEvent,
  CalendarGrantRevokedError,
  type MeetingSnapshot,
} from './google-calendar.google.js';
import { calendarCallbackTarget } from './google-calendar.controller.js';
import { GoogleCalendarService, editsFrom } from './google-calendar.service.js';
import { calendarSyncJobEnabled } from './calendar-sync.job.js';
import {
  isSupportedRrule,
  parseMeetingOptions,
  parseReminders,
} from '../calendar/meeting-options.js';
import type { MeetingRow } from '../../common/database/schema.js';

const SECRET = 'a-session-secret-long-enough-for-the-flow-cookie-000';
const owner = { organizationId: 'org_1', organizationSlug: 'northstar', userId: 'user_1' };

const snapshot: MeetingSnapshot = {
  id: 'mtg_1',
  title: 'Review',
  agendaNote: null,
  startsAt: new Date('2026-11-02T22:30:00.000Z'),
  endsAt: null,
  allDay: false,
  timeZone: 'Africa/Cairo',
  location: null,
  recurrenceRrule: 'FREQ=WEEKLY;BYDAY=MO',
  visibility: 'private',
  showAs: 'free',
  colorId: '5',
  conference: 'google_meet',
  reminders: [{ method: 'email', minutes: 1440 }],
  guestsCanModify: false,
  guestsCanInviteOthers: true,
  guestsCanSeeOthers: false,
  cancelled: false,
  attendees: [{ email: 'guest@example.com', optional: true, displayName: null }],
  attachments: [],
};

describe('Google Calendar protocol (0237)', () => {
  it('reads the calendar client, falling back to the Drive and sign-in clients', () => {
    expect(calendarConfigFrom({})).toBeNull();
    expect(calendarConfigFrom({ GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b' })).toEqual({
      clientId: 'a',
      clientSecret: 'b',
    });
    expect(
      calendarConfigFrom({
        GOOGLE_CALENDAR_CLIENT_ID: 'c',
        GOOGLE_CLIENT_ID: 'a',
        GOOGLE_CLIENT_SECRET: 'b',
      })?.clientId,
    ).toBe('c');
  });

  it('seals the flow; a forged, expired or other-purpose cookie is refused', () => {
    const flow = newCalendarFlow(owner, 1000);
    const sealed = sealCalendarFlow(flow, SECRET);
    expect(openCalendarFlow(sealed, SECRET, 1001)?.state).toBe(flow.state);
    expect(openCalendarFlow(`${sealed}x`, SECRET, 1001)).toBeUndefined();
    expect(openCalendarFlow(sealed, SECRET, 1000 + 601)).toBeUndefined();
    expect(
      openCalendarFlow(sealed, 'another-secret-another-secret-another-sec', 1001),
    ).toBeUndefined();
  });

  it('asks for calendar.events with incremental consent and PKCE, nothing broader', () => {
    const url = new URL(
      calendarAuthorizationUrl({
        clientId: 'c',
        redirectUri: 'https://x/cb',
        flow: newCalendarFlow(owner),
      }),
    );
    expect(url.searchParams.get('scope')).toBe(
      'openid email https://www.googleapis.com/auth/calendar.events',
    );
    expect(url.searchParams.get('include_granted_scopes')).toBe('true');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('forwards the code in the fragment to Connected apps, never to an unsigned slug', () => {
    const cookie = `tm_gcal_flow=${sealCalendarFlow(newCalendarFlow(owner), SECRET)}`;
    const options = { sessionSecret: SECRET, webPublicUrl: 'https://app.example/' };
    expect(calendarCallbackTarget(options, cookie, 'c1', 's1')).toBe(
      'https://app.example/northstar/settings/connected-apps#gcal=complete&code=c1&state=s1',
    );
    expect(calendarCallbackTarget(options, undefined, 'c1', 's1')).toBe('https://app.example/');
  });

  it('maps every option onto the Google event', () => {
    const body = toGoogleEvent(snapshot, { withConference: true, requestId: 'r1' });
    expect(body['start']).toEqual({
      dateTime: '2026-11-02T22:30:00.000Z',
      timeZone: 'Africa/Cairo',
    });
    expect(body['end']).toEqual({ dateTime: '2026-11-02T23:00:00.000Z', timeZone: 'Africa/Cairo' });
    expect(body).toMatchObject({
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
      visibility: 'private',
      transparency: 'transparent',
      colorId: '5',
      guestsCanSeeOtherGuests: false,
      reminders: { useDefault: false, overrides: [{ method: 'email', minutes: 1440 }] },
      attendees: [{ email: 'guest@example.com', optional: true }],
      conferenceData: { createRequest: { requestId: 'r1' } },
    });
    // All-day: dates in the meeting's zone, the end date exclusive.
    const allDay = toGoogleEvent(
      { ...snapshot, allDay: true },
      { withConference: false, requestId: 'r' },
    );
    expect(allDay['start']).toEqual({ date: '2026-11-03' });
    expect(allDay['end']).toEqual({ date: '2026-11-04' });
    expect(allDay).not.toHaveProperty('conferenceData');
  });

  it('reads the Meet link and answers back, and only https links', () => {
    const event = parseGoogleEvent({
      id: 'e1',
      htmlLink: 'javascript:alert(1)',
      conferenceData: {
        entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/a' }],
      },
      attendees: [{ email: 'A@B.co', responseStatus: 'tentative' }],
    });
    expect(event.joinUrl).toBe('https://meet.google.com/a');
    expect(event.htmlLink).toBeNull();
    expect(rsvpFromGoogle(event.attendees[0]?.responseStatus ?? '')).toBe('tentative');
    expect(rsvpFromGoogle('needsAction')).toBe('invited');
  });

  it('takes Google edits only for fields that differ', () => {
    const meeting = { title: 'Old', agendaNote: null, location: null, allDay: false } as MeetingRow;
    const event = parseGoogleEvent({ id: 'e', summary: 'New', description: '' });
    expect(editsFrom({ ...meeting, startsAt: new Date(0), endsAt: null }, event)).toEqual({
      title: 'New',
    });
  });

  it('the sync job runs only where background work runs in-process', () => {
    expect(calendarSyncJobEnabled({ WORKER_INPROCESS: '1' })).toBe(true);
    expect(calendarSyncJobEnabled({})).toBe(false);
  });
});

describe('meeting options (0237)', () => {
  it('accepts the supported RRULEs only', () => {
    expect(isSupportedRrule('FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=15;COUNT=6')).toBe(true);
    expect(isSupportedRrule('FREQ=HOURLY')).toBe(false);
    expect(isSupportedRrule('FREQ=DAILY;COUNT=2;UNTIL=20270101T000000Z')).toBe(false);
    expect(isSupportedRrule('FREQ=DAILY;FREQ=WEEKLY')).toBe(false);
  });

  it('parses every option and names each invalid field', () => {
    const details: { field: string; message: string }[] = [];
    const options = parseMeetingOptions(
      {
        allDay: true,
        timeZone: 'Mars/Base',
        rrule: 'RRULE:FREQ=DAILY',
        reminders: [{ method: 'sms', minutes: 1 }],
      },
      details,
    );
    expect(options).toEqual({ allDay: true, recurrenceRrule: 'FREQ=DAILY' });
    expect(details.map((d) => d.field)).toEqual(['timeZone', 'reminders']);
    expect(parseReminders('popup:10,bogus,email:60')).toEqual([
      { method: 'popup', minutes: 10 },
      { method: 'email', minutes: 60 },
    ]);
  });
});

describe('GoogleCalendarService push (0237)', () => {
  const meeting = {
    id: 'mtg_1',
    createdByUserId: 'user_1',
    updatedAt: new Date(),
    cancelledAt: null,
    reminders: null,
  };
  function service(connection: unknown, transport: Record<string, unknown>) {
    const update = vi.fn();
    const saveLink = vi.fn();
    const database = {
      read: (_c: unknown, f: (r: unknown) => unknown) => f({}),
      transaction: (_c: unknown, f: (r: unknown) => unknown) => f({}),
    };
    const svc = new GoogleCalendarService({
      database: database as never,
      audit: {} as never,
      transport: transport as never,
      cipher: { decrypt: () => 'rt', encrypt: () => 'enc' } as never,
      config: { clientId: 'c', clientSecret: 's' },
      apiPublicUrl: 'https://api',
      connections: {
        findFor: async () => connection,
        userEmail: async () => 'maya@x.co',
        update,
      } as never,
      meetings: { findById: async () => meeting } as never,
      calendar: {
        findLink: async () => null,
        roster: async () => [],
        listAttachments: async () => [],
        saveLink,
      } as never,
      log: () => undefined,
    });
    return { svc, update, saveLink };
  }
  const context = { organizationId: 'org_1', userId: 'user_1' } as never;

  it('does nothing when the organizer has not connected Google', async () => {
    const insertEvent = vi.fn();
    const { svc, saveLink } = service(null, { insertEvent });
    await svc.pushMeeting(context, 'mtg_1');
    expect(insertEvent).not.toHaveBeenCalled();
    expect(saveLink).not.toHaveBeenCalled();
  });

  it('a refused grant marks the connection revoked and the link in error, without throwing', async () => {
    const live = {
      id: 'conn_1',
      userId: 'user_1',
      status: 'connected',
      refreshTokenEnc: 'enc',
      calendarId: 'primary',
    };
    const refreshAccessToken = vi.fn().mockRejectedValue(new CalendarGrantRevokedError('no'));
    const { svc, update, saveLink } = service(live, { refreshAccessToken });
    await expect(svc.pushMeeting(context, 'mtg_1')).resolves.toBeUndefined();
    expect(update).toHaveBeenCalledWith({}, context, 'conn_1', {
      status: 'error',
      lastErrorCode: 'revoked',
    });
    expect(saveLink).toHaveBeenCalledWith({}, context, 'mtg_1', 'google', {
      connectionId: 'conn_1',
      syncStatus: 'error',
      lastErrorCode: 'revoked',
    });
  });
});
