import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { AppModule } from '../src/app.module.js';
import { DatabaseModule } from '../src/common/database/database.module.js';
import { MailerModule } from '../src/common/email/mailer.module.js';
import type { MailDelivery, Mailer, MailMessage } from '@tmanage/mail';
import { apiConfigFrom } from '../src/common/http/api-config.js';
import type { ApiConfig } from '../src/common/http/api-config.js';
import { CSRF_HEADER } from '../src/common/http/csrf.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * The mailer's first producer, over real HTTP — an invitation that is actually emailed.
 *
 * `ten-003-invitations.db.test.ts` boots the app with **no** mail wiring and stays green:
 * that is the `delivery: 'none'` deployment, the bootstrap default. This suite boots the
 * same application with `MailerModule.forMailer` handing it a transport the suite holds,
 * and proves the three sentences the slice adds:
 *
 * 1. An issued invitation is emailed — to the invited address, with the accept link built
 *    from the configured web origin, carrying the same token the response carries.
 * 2. A transport failure does not fail the invitation. The response is still 201, the
 *    token is still returned, and `delivery: 'failed'` plus an `invitation.emailed` audit
 *    row with `result = 'error'` say what happened instead of a 500 pretending nothing did.
 * 3. The audit trail records the delivery attempt the way it records the issue — the kind
 *    of invitation, never the address.
 */

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;

const SESSION_SECRET = 'local_dev_only_session_secret_for_invitation_mail_xxx';
const CSRF_SECRET = 'local_dev_only_csrf_secret_for_invitation_mail_xxxxxxx';
const WEB_URL = 'https://app.tmanage.example';

const CONFIG: ApiConfig = apiConfigFrom({
  NODE_ENV: 'test',
  ALLOW_DEV_SIGN_IN: true,
  SESSION_COOKIE_NAME: 'tmanage_session',
  SESSION_SECRET,
  SESSION_TTL_SECONDS: 900,
  REFRESH_TTL_SECONDS: 1_209_600,
  CSRF_SECRET,
  AUTH_MFA_SEED_KEYS: '1:local_dev_only_mfa_seed_key_change_me_00000',
  API_PUBLIC_URL: 'http://localhost:4000',
  AUTH_MAX_FAILURES_IN_WINDOW: 50,
  AUTH_FAILURE_WINDOW_SECONDS: 900,
  AUTH_TOTP_ISSUER: 'TManage',
  CLIENT_MEMBERSHIP_DEFAULT_EXPIRY_DAYS: 180,
});

/** The suite's transport: records what was sent, refuses or demurs when told to. */
class ScriptedMailer implements Mailer {
  readonly messages: MailMessage[] = [];
  refuse = false;
  /** Answer `'none'` the way the console driver does: compose received, nothing sent. */
  demur = false;

  send(message: MailMessage): Promise<MailDelivery> {
    if (this.refuse) return Promise.reject(new Error('scripted refusal'));
    this.messages.push(message);
    return Promise.resolve(this.demur ? 'none' : 'sent');
  }
}

const transport = new ScriptedMailer();

interface InjectedResponse {
  readonly statusCode: number;
  readonly body: string;
  readonly headers: Record<string, unknown>;
  json<T = unknown>(): T;
}

interface Session {
  readonly cookie: string;
  readonly csrfToken: string;
}

function setCookies(response: InjectedResponse): readonly string[] {
  const raw = response.headers['set-cookie'];
  if (Array.isArray(raw)) return raw as string[];
  return typeof raw === 'string' ? [raw] : [];
}

function cookieHeader(cookies: readonly string[]): string {
  return cookies
    .map((c) => c.split(';')[0] ?? '')
    .filter((pair) => pair.split('=').slice(1).join('=').length > 0)
    .join('; ');
}

function metadataOf(row: RowDataPacket): Record<string, unknown> {
  const raw = row['metadata_json'];
  return typeof raw === 'string'
    ? (JSON.parse(raw) as Record<string, unknown>)
    : (raw as Record<string, unknown>);
}

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

async function signIn(userId: string): Promise<Session> {
  const response = (await app.inject({
    method: 'POST',
    url: '/v1/dev/sessions',
    headers: { 'content-type': 'application/json' },
    payload: { userId },
  })) as unknown as InjectedResponse;
  const cookies = setCookies(response);
  return {
    cookie: cookieHeader(cookies),
    csrfToken: response.json<{ csrfToken: string }>().csrfToken,
  };
}

const NORTHSTAR = 'northstar-studio';

async function send(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  session: Session,
  payload?: unknown,
): Promise<InjectedResponse> {
  return (await app.inject({
    method,
    url,
    headers: {
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      cookie: session.cookie,
      ...(method === 'GET' ? {} : { [CSRF_HEADER]: session.csrfToken }),
    },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  })) as unknown as InjectedResponse;
}

interface Issued {
  invitation: { id: string; role: string; clientOrganizationId: string | null };
  token: string;
  delivery: 'sent' | 'none' | 'failed';
}

const owner = () => world.northstar.owner;

async function issue(session: Session, body: Record<string, unknown> = {}): Promise<Issued> {
  const response = await send('POST', `/v1/organizations/${NORTHSTAR}/invitations`, session, {
    email: 'nadia.fahmy@example.test',
    role: 'member',
    ...body,
  });
  if (response.statusCode !== 201) {
    throw new Error(`issue failed: ${response.statusCode} ${response.body}`);
  }
  return response.json<Issued>();
}

async function emailedEvents(invitationId: string): Promise<RowDataPacket[]> {
  return observe(
    `select * from audit_events where action = 'invitation.emailed' and object_id = ?`,
    [invitationId],
  );
}

beforeAll(async () => {
  db = await startTestDatabase();
  app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({
      config: CONFIG,
      database: DatabaseModule.forPool({ pool: db.runtime, guardMode: 'enforce' }),
      mailer: MailerModule.forMailer(transport, WEB_URL),
    }),
    new FastifyAdapter(),
    { logger: false, abortOnError: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}, 300_000);

beforeEach(async () => {
  transport.messages.length = 0;
  transport.refuse = false;
  transport.demur = false;
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
});

afterAll(async () => {
  await app?.close();
  await db?.stop();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('an issued invitation is emailed', () => {
  it('sends one message to the invited address, link built from the configured origin', async () => {
    const session = await signIn(owner().id);
    const issued = await issue(session);

    expect(issued.delivery).toBe('sent');
    expect(transport.messages).toHaveLength(1);

    const message = transport.messages[0]!;
    expect(message.to).toBe('nadia.fahmy@example.test');
    expect(message.text).toContain(`${WEB_URL}/invitations/${issued.token}`);

    // The subject carries the inviter and the organization as the database names them —
    // §3's internal template, filled from a join rather than from anything the caller sent.
    const orgs = await observe('select name from organizations where id = ?', [
      world.northstar.organizationId,
    ]);
    expect(message.subject).toContain(owner().displayName);
    expect(message.subject).toContain(String(orgs[0]!['name']));
  });

  it('records the delivery — the kind, the result, never the address', async () => {
    const session = await signIn(owner().id);
    const issued = await issue(session);

    const events = await emailedEvents(issued.invitation.id);
    expect(events).toHaveLength(1);
    expect(String(events[0]!['result'])).toBe('allowed');

    const metadata = metadataOf(events[0]!);
    expect(metadata['delivery']).toBe('sent');
    expect(metadata['destination']).toBe('organization');
    expect(JSON.stringify(metadata)).not.toContain('nadia');
  });

  it('renders the client template for a client invitation', async () => {
    const session = await signIn(owner().id);
    const issued = await issue(session, {
      email: 'guest@atlas.example.test',
      role: 'client_viewer',
      clientOrganizationId: world.atlas.clientOrganizationId,
    });

    expect(issued.delivery).toBe('sent');
    const message = transport.messages[0]!;
    // EMAIL-COPY (7703e3cd): a client invitation has its own subject, naming the portal.
    expect(message.subject).toBe('Maya Hassan invited you to the Northstar Studio client portal');
    expect(message.text).toContain('Northstar Studio client portal');
    expect(message.text).toContain('Atlas Hospitality');

    const events = await emailedEvents(issued.invitation.id);
    expect(metadataOf(events[0]!)['destination']).toBe('client_organization');
  });

  it('emails the reissued invitation with the new token', async () => {
    const session = await signIn(owner().id);
    const first = await issue(session);
    transport.messages.length = 0;

    const response = await send(
      'POST',
      `/v1/organizations/${NORTHSTAR}/invitations/${first.invitation.id}/reissues`,
      session,
      {},
    );
    expect(response.statusCode).toBe(201);
    const reissued = response.json<Issued>();

    expect(reissued.delivery).toBe('sent');
    expect(transport.messages).toHaveLength(1);
    expect(transport.messages[0]!.text).toContain(`${WEB_URL}/invitations/${reissued.token}`);
    expect(reissued.token).not.toBe(first.token);
  });
});

describe("a transport's 'none' is nobody's error", () => {
  it('writes no invitation.emailed row for a delivery nothing attempted', async () => {
    // The console driver's shape: the transport composes (its whole purpose is showing the
    // mail) and answers 'none'. The first review of this slice found that path audited as
    // result='error' — an error row per healthy invitation in every dev deployment.
    const session = await signIn(owner().id);
    transport.demur = true;
    const issued = await issue(session);

    expect(issued.delivery).toBe('none');
    expect(transport.messages).toHaveLength(1);
    await expect(emailedEvents(issued.invitation.id)).resolves.toHaveLength(0);
  });
});

describe('a transport failure is a fact, not an error', () => {
  it('answers 201 with the token and delivery=failed, and audits result=error', async () => {
    const session = await signIn(owner().id);
    transport.refuse = true;
    // `InvitationMailer` reports the refusal to the operator's log; keep the suite quiet.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let issued: Issued;
    try {
      issued = await issue(session);
    } finally {
      spy.mockRestore();
    }

    expect(issued.delivery).toBe('failed');
    expect(issued.token.length).toBeGreaterThan(40);

    // The invitation stands: the row is pending and the link the issuer holds will work.
    const rows = await observe('select status from invitations where id = ?', [
      issued.invitation.id,
    ]);
    expect(String(rows[0]!['status'])).toBe('pending');

    const events = await emailedEvents(issued.invitation.id);
    expect(events).toHaveLength(1);
    expect(String(events[0]!['result'])).toBe('error');
    expect(metadataOf(events[0]!)['delivery']).toBe('failed');
  });
});
