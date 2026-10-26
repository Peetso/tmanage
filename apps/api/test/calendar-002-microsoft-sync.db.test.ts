import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { CSRF_HEADER } from '../src/common/http/csrf.js';
import type { TestDatabase } from './support/test-database.js';
import type { SeedWorld } from './seed-two-tenants.js';
import {
  bootHttpHarness,
  cookieHeader,
  reseed,
  setCookies,
  signIn,
  stopHarness,
} from './support/http-harness.js';
import type { InjectedResponse, Session } from './support/http-harness.js';

/**
 * CALENDAR-002 over real HTTP and a real database — meetings connected to Outlook/Teams
 * (0237 slice B; no migration of its own: 0237's tables are provider-generic). Microsoft is a
 * stubbed `fetch`: no request leaves for a real Microsoft endpoint.
 *
 * Connect Outlook, create a Teams meeting with a guest — Graph gets the event (Teams requested,
 * attendees typed) — the meeting page shows the Teams Join link and the guest's answer pulled
 * back; cancel sends Outlook's cancellation. With Google connected too, a Teams meeting goes to
 * Outlook only.
 */

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;

const ENV = {
  MICROSOFT_CLIENT_ID: 'test-ms-client',
  MICROSOFT_CLIENT_SECRET: 'test-ms-secret',
  GOOGLE_CALENDAR_CLIENT_ID: 'test-gcal-client',
  GOOGLE_CALENDAR_CLIENT_SECRET: 'test-gcal-secret',
};
const saved = new Map<string, string | undefined>();

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

async function send(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  session: Session,
  payload?: unknown,
  extraCookie = '',
): Promise<InjectedResponse> {
  return (await app.inject({
    method,
    url: `/v1/organizations/northstar-studio${path}`,
    headers: {
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      cookie: extraCookie ? `${session.cookie}; ${extraCookie}` : session.cookie,
      ...(method === 'GET' ? {} : { [CSRF_HEADER]: session.csrfToken }),
    },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  })) as unknown as InjectedResponse;
}

/** A stub Microsoft (+ Google token endpoint): records every call. */
function stubMicrosoft() {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const idToken = `x.${Buffer.from(JSON.stringify({ email: 'maya@contoso.example' })).toString('base64url')}.y`;
  let created: Record<string, unknown> = {};
  const event = () => ({
    id: 'mevt_1',
    iCalUId: 'uid_m1',
    changeKey: 'ck1',
    lastModifiedDateTime: '2000-01-01T00:00:00Z',
    webLink: 'https://outlook.office365.com/owa/?itemid=mevt_1',
    onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc' },
    subject: created['subject'],
    attendees: ((created['attendees'] as { emailAddress: { address: string } }[]) ?? []).map(
      (a) => ({
        ...a,
        status: { response: a.emailAddress.address === 'guest@example.com' ? 'accepted' : 'none' },
      }),
    ),
  });
  const fake = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const raw = typeof init?.body === 'string' ? init.body : '';
    const body = raw.startsWith('{') ? (JSON.parse(raw) as Record<string, unknown>) : raw;
    calls.push({ method, url, body });
    const reply = (status: number, json?: unknown) =>
      new Response(json === undefined ? null : JSON.stringify(json), { status });
    if (url.startsWith('https://login.microsoftonline.com/common/oauth2/v2.0/token')) {
      return raw.includes('grant_type=authorization_code')
        ? reply(200, {
            access_token: 'mat_1',
            refresh_token: 'mrt_secret_1',
            scope: 'openid profile email offline_access Calendars.ReadWrite',
            id_token: idToken,
            expires_in: 3600,
          })
        : reply(200, { access_token: 'mat_2', refresh_token: 'mrt_secret_2', expires_in: 3600 });
    }
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return reply(200, { access_token: 'gat', expires_in: 3600 });
    }
    if (url === 'https://graph.microsoft.com/v1.0/me/events' && method === 'POST') {
      created = body as Record<string, unknown>;
      return reply(201, event());
    }
    if (url.startsWith('https://graph.microsoft.com/v1.0/me/events/mevt_1')) {
      if (url.endsWith('/cancel')) return reply(202);
      return reply(200, event());
    }
    return reply(404, {});
  });
  return { fake, calls };
}

beforeAll(async () => {
  for (const [key, value] of Object.entries(ENV)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  ({ app, db } = await bootHttpHarness({
    secretTag: 'the_calendar_002_suite',
    guardMode: 'enforce',
  }));
}, 300_000);

beforeEach(async () => {
  world = await reseed(db);
  for (const table of [
    'meeting_external_events',
    'meeting_guests',
    'meeting_attachments',
    'calendar_connections',
  ]) {
    await db.admin.query(`delete from \`${table}\``);
  }
});

afterEach(() => vi.unstubAllGlobals());

afterAll(async () => {
  await stopHarness({ app, db });
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function connectOutlook(owner: Session): Promise<void> {
  const connect = await send('POST', '/integrations/microsoft-calendar/connect', owner, {});
  expect(connect.statusCode, connect.body).toBe(200);
  const consent = new URL(connect.json<{ url: string }>().url);
  expect(consent.searchParams.get('scope')).toContain('Calendars.ReadWrite');
  const flowCookie = cookieHeader(setCookies(connect));
  expect(flowCookie).toContain('tm_mscal_flow=');
  const complete = await send(
    'POST',
    '/integrations/microsoft-calendar/complete',
    owner,
    { code: 'code_1', state: consent.searchParams.get('state') },
    flowCookie,
  );
  expect(complete.statusCode, complete.body).toBe(200);
  expect(complete.json<{ microsoft: { status: string } }>().microsoft).toMatchObject({
    status: 'connected',
    accountEmail: 'maya@contoso.example',
  });
}

describe('0237 slice B — Outlook connect, push, the meeting page, pull and cancel', () => {
  it('runs a Teams meeting end to end against a stubbed Graph', async () => {
    const ms = stubMicrosoft();
    vi.stubGlobal('fetch', ms.fake);
    const owner = await signIn(app, world.northstar.owner.id);
    await connectOutlook(owner);
    const [row] = await observe(
      "select refresh_token_enc as enc from calendar_connections where provider = 'microsoft'",
    );
    expect(String(row?.['enc'])).not.toContain('mrt_secret_1');

    const startsAt = new Date(Date.now() + 86_400_000).toISOString();
    const created = await send('POST', '/meetings', owner, {
      projectId: world.northstar.projectId,
      title: 'Client review',
      startsAt,
      timeZone: 'Africa/Cairo',
      conference: 'teams',
      rrule: 'FREQ=WEEKLY;BYDAY=TU',
      reminders: [{ method: 'popup', minutes: 10 }],
      attendees: [{ userId: world.northstar.designer.id, optional: true }],
      guests: [{ email: 'Guest@Example.com' }],
    });
    expect(created.statusCode, created.body).toBe(201);
    const meetingId = created.json<{ id: string }>().id;
    const insert = ms.calls.find(
      (c) => c.method === 'POST' && c.url === 'https://graph.microsoft.com/v1.0/me/events',
    );
    const sent = insert?.body as Record<string, unknown>;
    expect(sent).toMatchObject({
      subject: 'Client review',
      isOnlineMeeting: true,
      onlineMeetingProvider: 'teamsForBusiness',
      reminderMinutesBeforeStart: 10,
      transactionId: meetingId,
      recurrence: { pattern: { type: 'weekly', daysOfWeek: ['tuesday'] } },
    });
    expect(sent['attendees']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ emailAddress: { address: 'guest@example.com' } }),
      ]),
    );
    const designer = await signIn(app, world.northstar.designer.id);
    const page = await send('GET', `/meetings/${meetingId}/overview`, designer);
    expect(page.statusCode, page.body).toBe(200);
    const overview = page.json<{
      external: { provider: string; joinUrl: string; syncStatus: string };
      people: { kind: string; email: string | null; rsvp: string }[];
    }>();
    expect(overview.external).toMatchObject({
      provider: 'microsoft',
      joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc',
      syncStatus: 'synced',
    });
    expect(overview.people.find((p) => p.kind === 'guest')).toMatchObject({
      email: 'guest@example.com',
      rsvp: 'accepted',
    });

    const cancel = await send('POST', `/meetings/${meetingId}/cancel`, owner, {});
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect(ms.calls.some((c) => c.method === 'POST' && c.url.endsWith('/mevt_1/cancel'))).toBe(
      true,
    );

    const disconnect = await send('DELETE', '/integrations/microsoft-calendar', owner);
    expect(disconnect.json<{ microsoft: { status: string } }>().microsoft.status).toBe(
      'not_connected',
    );
  });

  it('with Google connected too, a Teams meeting goes to Outlook only', async () => {
    const ms = stubMicrosoft();
    vi.stubGlobal('fetch', ms.fake);
    const owner = await signIn(app, world.northstar.owner.id);
    await connectOutlook(owner);
    await db.admin.query(
      `insert into calendar_connections
         (id, organization_id, user_id, provider, status, refresh_token_enc)
       values (uuid(), ?, ?, 'google', 'connected', 'not-a-real-token')`,
      [world.northstar.organizationId, world.northstar.owner.id],
    );
    const created = await send('POST', '/meetings', owner, {
      projectId: world.northstar.projectId,
      title: 'Teams only',
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      conference: 'teams',
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(ms.calls.some((c) => c.url.includes('googleapis.com'))).toBe(false);
    const links = await observe(
      'select provider from meeting_external_events where meeting_id = ?',
      [created.json<{ id: string }>().id],
    );
    expect(links.map((l) => l['provider'])).toEqual(['microsoft']);
  });
});
