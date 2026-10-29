import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { uuidv7 } from '@tmanage/domain';
import { CSRF_HEADER } from '../src/common/http/csrf.js';
import { parseGrantScript } from '../src/common/database/grants.js';
import { TABLES } from '../src/common/database/schema.js';
import { TENANT_TABLES } from '../src/common/database/tenant-guard.js';
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
 * CALENDAR-001 over real HTTP and a real database — meetings connected to Google Calendar/Meet
 * (migration 0237). Google is a stubbed `fetch`: no request leaves for a real Google endpoint.
 *
 * 1. Registry in all four places, identity pinned, tenancy enforced, one connection per person.
 * 2. Owner bug 1: `GET /meetings` without a project lists every readable meeting in the window.
 * 3. Owner bug 2 + push/pull: connect, create a Meet meeting with a guest — Google gets the event
 *    (Meet requested, invitations sent) — the meeting page shows the Join link and the guest's
 *    answer pulled back; cancel deletes the Google event.
 */

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;

const HERE = dirname(fileURLToPath(import.meta.url));
const intents = parseGrantScript(
  readFileSync(resolve(HERE, '../../../scripts/db/users.sql'), 'utf8'),
);
const NEW_TABLES = [
  'calendar_connections',
  'meeting_external_events',
  'meeting_guests',
  'meeting_attachments',
];
const ENV = {
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

/** A stub Google: token endpoint, events insert/get/delete. Records every call. */
function stubGoogle() {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const idToken = `x.${Buffer.from(JSON.stringify({ email: 'maya@gmail.example' })).toString('base64url')}.y`;
  const event = (body: Record<string, unknown>) => ({
    id: 'evt_1',
    status: 'confirmed',
    etag: '"e1"',
    updated: '2000-01-01T00:00:00.000Z',
    htmlLink: 'https://www.google.com/calendar/event?eid=evt_1',
    hangoutLink: 'https://meet.google.com/abc-defg-hij',
    iCalUID: 'evt_1@google.com',
    attendees: body['attendees'],
  });
  let inserted: Record<string, unknown> = {};
  const fake = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const raw = typeof init?.body === 'string' ? init.body : '';
    const body = raw.startsWith('{') ? (JSON.parse(raw) as Record<string, unknown>) : raw;
    calls.push({ method, url, body });
    const reply = (status: number, json?: unknown) =>
      new Response(json === undefined ? null : JSON.stringify(json), { status });
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return raw.includes('grant_type=authorization_code')
        ? reply(200, {
            access_token: 'at_1',
            refresh_token: 'rt_secret_1',
            scope: 'openid email https://www.googleapis.com/auth/calendar.events',
            id_token: idToken,
          })
        : reply(200, { access_token: 'at_2', expires_in: 3600 });
    }
    if (url.includes('/calendar/v3/calendars/primary/events')) {
      if (method === 'POST') {
        inserted = body as Record<string, unknown>;
        return reply(200, event(inserted));
      }
      if (method === 'DELETE') return reply(204);
      // GET: the guest answered "yes" in Gmail.
      const attendees = (inserted['attendees'] as { email: string }[]).map((a) =>
        a.email === 'guest@example.com' ? { ...a, responseStatus: 'accepted' } : a,
      );
      return reply(200, event({ attendees }));
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
    secretTag: 'the_calendar_001_suite',
    guardMode: 'enforce',
  }));
}, 300_000);

beforeEach(async () => {
  world = await reseed(db);
  for (const table of [...NEW_TABLES.slice(1), 'calendar_connections']) {
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

describe('0237 — registry, identity and tenancy', () => {
  it('the four tables are registered everywhere, with runtime grants and none for the worker', async () => {
    const onTable = (user: string, table: string) =>
      [...(intents.get(`'${user}'@'%'`)?.privileges ?? [])].filter((k) =>
        k.startsWith(`tmanage.${table}:`),
      );
    for (const table of NEW_TABLES) {
      expect(Object.keys(TABLES)).toContain(table);
      expect(TENANT_TABLES[table]).toBe('organization_id');
      expect(onTable('tmanage_app', table)).toContain(`tmanage.${table}:INSERT`);
      // platform-admin v2 · PA-03: the content purge reads and deletes soft-deleted attachments.
      expect(onTable('tmanage_worker', table).sort()).toEqual(
        table === 'meeting_attachments'
          ? ['tmanage.meeting_attachments:DELETE', 'tmanage.meeting_attachments:SELECT']
          : [],
      );
    }
    const columns = await observe(
      `select column_name as name from information_schema.columns
        where table_schema = database() and table_name = 'meetings'
          and column_name in ('conference', 'recurrence_rrule', 'cancelled_at', 'reminders')`,
    );
    expect(columns).toHaveLength(4);
  });

  it('one connection per person and provider, identity pinned, no cross-tenant link', async () => {
    const org = world.northstar.organizationId;
    const insert = (id: string, provider: string) =>
      db.admin.query(
        `insert into calendar_connections (id, organization_id, user_id, provider, status)
         values (?, ?, ?, ?, 'connected')`,
        [id, org, world.northstar.owner.id, provider],
      );
    const connectionId = uuidv7();
    await insert(connectionId, 'google');
    await insert(uuidv7(), 'microsoft');
    await expect(insert(uuidv7(), 'google')).rejects.toThrow(/duplicate/i);
    await expect(
      db.admin.query("update calendar_connections set provider = 'microsoft2' where id = ?", [
        connectionId,
      ]),
    ).rejects.toThrow(/immutable/);
    const meetingId = uuidv7();
    await db.admin.query(
      `insert into meetings (id, organization_id, project_id, title, starts_at, created_by_user_id)
       values (?, ?, ?, 'Kickoff', current_timestamp(3), ?)`,
      [meetingId, org, world.northstar.projectId, world.northstar.owner.id],
    );
    // The twin can name neither Northstar's meeting nor its connection.
    await expect(
      db.admin.query(
        `insert into meeting_guests (id, organization_id, meeting_id, email) values (?, ?, ?, 'a@b.co')`,
        [uuidv7(), world.twin.organizationId, meetingId],
      ),
    ).rejects.toThrow(/foreign key/i);
    await expect(
      db.admin.query(
        `insert into meeting_external_events (id, organization_id, meeting_id, connection_id, provider)
         values (?, ?, ?, ?, 'google')`,
        [uuidv7(), world.twin.organizationId, meetingId, connectionId],
      ),
    ).rejects.toThrow(/foreign key/i);
  });
});

describe('0237 — connect, push, the meeting page, pull and cancel', () => {
  it('runs a Meet meeting end to end against a stubbed Google', async () => {
    const google = stubGoogle();
    vi.stubGlobal('fetch', google.fake);
    const owner = await signIn(app, world.northstar.owner.id);

    const connect = await send('POST', '/integrations/google-calendar/connect', owner, {});
    expect(connect.statusCode, connect.body).toBe(200);
    const consent = new URL(connect.json<{ url: string }>().url);
    expect(consent.searchParams.get('scope')).toContain('auth/calendar.events');
    expect(consent.searchParams.get('include_granted_scopes')).toBe('true');
    const flowCookie = cookieHeader(setCookies(connect));
    expect(flowCookie).toContain('tm_gcal_flow=');

    const complete = await send(
      'POST',
      '/integrations/google-calendar/complete',
      owner,
      { code: 'code_1', state: consent.searchParams.get('state') },
      flowCookie,
    );
    expect(complete.statusCode, complete.body).toBe(200);
    expect(complete.json<{ google: { status: string } }>().google.status).toBe('connected');
    const [row] = await observe('select refresh_token_enc as enc from calendar_connections');
    expect(String(row?.['enc'])).not.toContain('rt_secret_1');

    const startsAt = new Date(Date.now() + 86_400_000).toISOString();
    const created = await send('POST', '/meetings', owner, {
      projectId: world.northstar.projectId,
      title: 'Design review',
      startsAt,
      conference: 'google_meet',
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
      reminders: [{ method: 'popup', minutes: 10 }],
      attendees: [{ userId: world.northstar.designer.id, optional: true }],
      guests: [{ email: 'Guest@Example.com' }],
    });
    expect(created.statusCode, created.body).toBe(201);
    const meetingId = created.json<{ id: string }>().id;
    const insert = google.calls.find((c) => c.method === 'POST' && c.url.includes('/events?'));
    expect(insert?.url).toContain('sendUpdates=all');
    const sent = insert?.body as Record<string, unknown>;
    expect(sent['conferenceData']).toMatchObject({
      createRequest: { conferenceSolutionKey: { type: 'hangoutsMeet' } },
    });
    expect(sent['recurrence']).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=MO']);
    expect(sent['attendees']).toEqual(
      expect.arrayContaining([expect.objectContaining({ email: 'guest@example.com' })]),
    );

    // Owner bug 1: no project chosen — the designer (a project member) sees the meeting.
    const designer = await signIn(app, world.northstar.designer.id);
    const all = await send('GET', '/meetings', designer);
    expect(all.statusCode, all.body).toBe(200);
    expect(all.json<{ meetings: { id: string }[] }>().meetings.map((m) => m.id)).toContain(
      meetingId,
    );

    // Owner bug 2: the meeting page opens by id, with the Join link and the guest's answer.
    const page = await send('GET', `/meetings/${meetingId}/overview`, designer);
    expect(page.statusCode, page.body).toBe(200);
    const overview = page.json<{
      external: { joinUrl: string; syncStatus: string };
      people: { kind: string; email: string | null; rsvp: string; optional: boolean }[];
    }>();
    expect(overview.external).toMatchObject({
      joinUrl: 'https://meet.google.com/abc-defg-hij',
      syncStatus: 'synced',
    });
    expect(overview.people.find((p) => p.kind === 'guest')).toMatchObject({
      email: 'guest@example.com',
      rsvp: 'accepted',
    });

    const cancel = await send('POST', `/meetings/${meetingId}/cancel`, owner, {});
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect(google.calls.some((c) => c.method === 'DELETE' && c.url.includes('/events/evt_1'))).toBe(
      true,
    );
    const after = await send('GET', '/meetings', owner);
    expect(after.json<{ meetings: { id: string }[] }>().meetings.map((m) => m.id)).not.toContain(
      meetingId,
    );
  });
});
