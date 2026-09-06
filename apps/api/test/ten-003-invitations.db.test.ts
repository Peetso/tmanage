import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { AppModule } from '../src/app.module.js';
import { DatabaseModule } from '../src/common/database/database.module.js';
import { apiConfigFrom } from '../src/common/http/api-config.js';
import type { ApiConfig } from '../src/common/http/api-config.js';
import { CSRF_HEADER } from '../src/common/http/csrf.js';
import type { TenantGuardEvent } from '../src/common/database/tenant-guard.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * TEN-003 over real HTTP — how somebody who is not in an organization gets into one.
 *
 * Four things only this suite can show:
 *
 * 1. **The token is never stored.** The row holds a SHA-256 hash, the plaintext appears in
 *    exactly one response, and no later read can produce it.
 * 2. **Acceptance works with no tenant context.** `TenantContextGuard` cannot resolve one for
 *    somebody with no membership, so the route carries `@NoTenant()` and the service builds a
 *    context from the invitation row — through a `bootstrapRead` that is read-only, audited
 *    and allowlisted to one table.
 * 3. **The token is single-use.** The `status = 'pending'` predicate on the accepting `UPDATE`
 *    is what makes it so, and the second attempt gets the same refusal as a token that never
 *    existed.
 * 4. **Every refusal is the same refusal.** Missing, revoked, expired and already-used all
 *    answer 404 with one message. Telling a stolen link which of the four it hit would confirm
 *    the address is real.
 */

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;
let guardEvents: TenantGuardEvent[];

const SESSION_SECRET = 'local_dev_only_session_secret_for_invitations_suite_x';
const CSRF_SECRET = 'local_dev_only_csrf_secret_for_invitations_suite_xxxxxx';

const CONFIG: ApiConfig = apiConfigFrom({
  NODE_ENV: 'test',
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

function orgUrl(path: string): string {
  return `/v1/organizations/${NORTHSTAR}${path}`;
}

interface Invitation {
  id: string;
  email: string;
  role: string;
  clientOrganizationId: string | null;
  status: string;
  expiresAt: string;
}

interface Issued {
  invitation: Invitation;
  token: string;
  delivery: 'sent' | 'none' | 'failed';
}

const owner = () => world.northstar.owner;
const designer = () => world.northstar.designer;

/** Somebody with an account and no membership in Northstar. */
const outsider = () => world.brightops.owner;

async function issue(session: Session, body: Record<string, unknown> = {}): Promise<Issued> {
  const response = await send('POST', orgUrl('/invitations'), session, {
    email: 'nadia.fahmy@example.test',
    role: 'member',
    ...body,
  });
  if (response.statusCode !== 201) {
    throw new Error(`issue failed: ${response.statusCode} ${response.body}`);
  }
  return response.json<Issued>();
}

async function accept(session: Session, token: string): Promise<InjectedResponse> {
  return send('POST', '/v1/invitations/acceptances', session, { token });
}

beforeAll(async () => {
  db = await startTestDatabase();
  guardEvents = [];
  app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({
      config: CONFIG,
      database: DatabaseModule.forPool({
        pool: db.runtime,
        guardMode: 'enforce',
        onGuardEvent: (event) => guardEvents.push(event),
      }),
    }),
    new FastifyAdapter(),
    { logger: false, abortOnError: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}, 300_000);

beforeEach(async () => {
  guardEvents.length = 0;
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
});

afterAll(async () => {
  await app?.close();
  await db?.stop();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('issuing', () => {
  it('stores a hash and returns the token exactly once', async () => {
    const session = await signIn(owner().id);
    const { invitation, token } = await issue(session);

    expect(token.length).toBeGreaterThan(40);

    const rows = await observe('select token_hash from invitations where id = ?', [invitation.id]);
    const stored = String(rows[0]!['token_hash']);
    expect(stored).toHaveLength(64);
    expect(stored).not.toContain(token);
    expect(stored).toBe(createHash('sha256').update(token, 'utf8').digest('hex'));

    // Nothing that reads the invitation back can produce the token or its hash.
    const listed = await send('GET', orgUrl('/invitations'), session);
    expect(listed.body).not.toContain(token);
    expect(listed.body).not.toContain(stored);
  });

  it('answers delivery=none and audits no email when no mail wiring exists', async () => {
    // This application was built with no `mailer` option, which is the bootstrap fallback
    // the mailer slice keeps: the printed link is the whole delivery story. Pinned here —
    // not merely "the suite stays green" — because a regression that answered 'failed'
    // would tell every no-SMTP issuer their email broke, and one that wrote an
    // `invitation.emailed` row would record attempts nothing made.
    const session = await signIn(owner().id);
    const issued = await issue(session);

    expect(issued.delivery).toBe('none');

    const emailed = await observe(
      `select id from audit_events where action = 'invitation.emailed' and object_id = ?`,
      [issued.invitation.id],
    );
    expect(emailed).toHaveLength(0);
  });

  it('records the issue, with the kind of invitation and never the address', async () => {
    const session = await signIn(owner().id);
    const { invitation } = await issue(session);

    const events = await observe(
      `select * from audit_events where action = 'invitation.issued' and object_id = ?`,
      [invitation.id],
    );
    expect(events).toHaveLength(1);

    const metadata = metadataOf(events[0]!);
    expect(metadata['destination']).toBe('organization');
    expect(metadata['role']).toBe('member');
    expect(JSON.stringify(metadata)).not.toContain('nadia');
  });

  it('refuses an internal role on a client invitation, and the reverse', async () => {
    const session = await signIn(owner().id);

    const internalRoleForClient = await send('POST', orgUrl('/invitations'), session, {
      email: 'a@example.test',
      role: 'member',
      clientOrganizationId: world.atlas.clientOrganizationId,
    });
    expect(internalRoleForClient.statusCode).toBe(400);

    const clientRoleForInternal = await send('POST', orgUrl('/invitations'), session, {
      email: 'b@example.test',
      role: 'client_viewer',
    });
    expect(clientRoleForInternal.statusCode).toBe(400);
  });

  it('refuses a second pending invitation for the same address', async () => {
    const session = await signIn(owner().id);
    await issue(session);

    const again = await send('POST', orgUrl('/invitations'), session, {
      email: 'nadia.fahmy@example.test',
      role: 'member',
    });
    expect(again.statusCode).toBe(409);

    const rows = await observe('select id from invitations where email = ?', [
      'nadia.fahmy@example.test',
    ]);
    expect(rows).toHaveLength(1);
  });

  it('refuses a caller without org.manage', async () => {
    const session = await signIn(designer().id);
    const response = await send('POST', orgUrl('/invitations'), session, {
      email: 'c@example.test',
      role: 'member',
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('previewing, which happens before signing in', () => {
  it('tells the holder who invited them and to what, with no session at all', async () => {
    const inviter = await signIn(owner().id);
    const { token } = await issue(inviter);

    const response = (await app.inject({
      method: 'POST',
      url: '/v1/invitations/previews',
      headers: { 'content-type': 'application/json' },
      payload: { token },
    })) as unknown as InjectedResponse;

    expect(response.statusCode).toBe(200);
    const preview = response.json<{
      organizationName: string;
      inviterName: string;
      inviterEmail: string;
      role: string;
      audience: string;
      clientOrganizationName: string | null;
    }>();

    expect(preview.organizationName).toBe('Northstar Studio');
    expect(preview.inviterEmail).toBe(owner().email);
    expect(preview.role).toBe('member');
    expect(preview.audience).toBe('internal');
    expect(preview.clientOrganizationName).toBeNull();
  });

  it('names the client organization when the invitation is portal access', async () => {
    const inviter = await signIn(owner().id);
    const { token } = await issue(inviter, {
      email: 'karim.said@atlas.example',
      role: 'client_viewer',
      clientOrganizationId: world.atlas.clientOrganizationId,
    });

    const response = (await app.inject({
      method: 'POST',
      url: '/v1/invitations/previews',
      headers: { 'content-type': 'application/json' },
      payload: { token },
    })) as unknown as InjectedResponse;

    expect(response.statusCode).toBe(200);
    const preview = response.json<{ audience: string; clientOrganizationName: string | null }>();
    expect(preview.audience).toBe('client');
    expect(preview.clientOrganizationName).toBe('Atlas Hospitality');
  });

  it('refuses a revoked token exactly as it refuses one that never existed', async () => {
    const inviter = await signIn(owner().id);
    const { invitation, token } = await issue(inviter);
    await send('DELETE', orgUrl(`/invitations/${invitation.id}`), inviter);

    const preview = async (candidate: string) =>
      (await app.inject({
        method: 'POST',
        url: '/v1/invitations/previews',
        headers: { 'content-type': 'application/json' },
        payload: { token: candidate },
      })) as unknown as InjectedResponse;

    const revoked = await preview(token);
    const nonexistent = await preview('b'.repeat(43));

    // The preview must not become the oracle the acceptance path refuses to be.
    expect(revoked.statusCode).toBe(404);
    expect(nonexistent.statusCode).toBe(404);
    const strip = (body: string) => body.replace(/"correlationId":"[^"]+"/, '');
    expect(strip(revoked.body)).toBe(strip(nonexistent.body));
  });

  it('never returns the token or its hash', async () => {
    const inviter = await signIn(owner().id);
    const { token } = await issue(inviter);

    const response = (await app.inject({
      method: 'POST',
      url: '/v1/invitations/previews',
      headers: { 'content-type': 'application/json' },
      payload: { token },
    })) as unknown as InjectedResponse;

    const stored = String(
      (await observe('select token_hash from invitations limit 1'))[0]!['token_hash'],
    );
    expect(response.body).not.toContain(token);
    expect(response.body).not.toContain(stored);
  });
});

describe('accepting, which happens with no tenant context', () => {
  it('creates an active membership for a person who had none', async () => {
    const inviter = await signIn(owner().id);
    const { token } = await issue(inviter);

    const before = await observe(
      'select id from memberships where organization_id = ? and user_id = ?',
      [world.northstar.organizationId, outsider().id],
    );
    expect(before).toHaveLength(0);

    const invitee = await signIn(outsider().id);
    const response = await accept(invitee, token);
    expect(response.statusCode).toBe(201);

    const rows = await observe(
      'select status, role from memberships where organization_id = ? and user_id = ?',
      [world.northstar.organizationId, outsider().id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!['status']).toBe('active');
    expect(rows[0]!['role']).toBe('member');
  });

  it('lets the newly admitted person use the organization immediately', async () => {
    const inviter = await signIn(owner().id);
    const { token } = await issue(inviter);

    const invitee = await signIn(outsider().id);
    // Before: no membership, so the tenant guard refuses at the slug.
    const before = await send('GET', orgUrl('/work-items'), invitee);
    expect(before.statusCode).toBe(404);

    await accept(invitee, token);

    // After: the membership the acceptance created is what the guard resolves.
    const after = await send('GET', orgUrl('/work-items'), invitee);
    expect(after.statusCode).toBe(200);
  });

  it('records the acceptance against the organization the invitation named', async () => {
    const inviter = await signIn(owner().id);
    const { invitation, token } = await issue(inviter);

    const invitee = await signIn(outsider().id);
    await accept(invitee, token);

    const events = await observe(
      `select * from audit_events where action = 'invitation.accepted' and object_id = ?`,
      [invitation.id],
    );
    expect(events).toHaveLength(1);
    expect(events[0]!['organization_id']).toBe(world.northstar.organizationId);
    expect(events[0]!['actor_user_id']).toBe(outsider().id);
  });

  it('is single-use — the second attempt is refused and creates nothing', async () => {
    const inviter = await signIn(owner().id);
    const { token } = await issue(inviter);

    const invitee = await signIn(outsider().id);
    expect((await accept(invitee, token)).statusCode).toBe(201);

    const second = await accept(invitee, token);
    expect(second.statusCode).toBe(404);

    const rows = await observe(
      'select id from memberships where organization_id = ? and user_id = ?',
      [world.northstar.organizationId, outsider().id],
    );
    expect(rows).toHaveLength(1);
  });

  it('answers the same for a revoked token as for one that never existed', async () => {
    const inviter = await signIn(owner().id);
    const { invitation, token } = await issue(inviter);
    expect(
      (await send('DELETE', orgUrl(`/invitations/${invitation.id}`), inviter)).statusCode,
    ).toBe(200);

    const invitee = await signIn(outsider().id);
    const revoked = await accept(invitee, token);
    const nonexistent = await accept(invitee, 'a'.repeat(43));

    expect(revoked.statusCode).toBe(404);
    expect(nonexistent.statusCode).toBe(404);

    const strip = (body: string) => body.replace(/"correlationId":"[^"]+"/, '');
    expect(strip(revoked.body)).toBe(strip(nonexistent.body));
  });

  it('refuses an expired token, and the row is what decides', async () => {
    const inviter = await signIn(owner().id);
    const { invitation, token } = await issue(inviter);

    // Reach past the API to age the row: there is no route that can, deliberately.
    await db.admin.query(
      'update invitations set expires_at = date_sub(current_timestamp(3), interval 1 day) where id = ?',
      [invitation.id],
    );

    const invitee = await signIn(outsider().id);
    expect((await accept(invitee, token)).statusCode).toBe(404);

    // Still `pending` — nothing swept it — and still refused. Expiry is enforced by the
    // comparison, not by the status column.
    const rows = await observe('select status from invitations where id = ?', [invitation.id]);
    expect(rows[0]!['status']).toBe('pending');
  });

  it('refuses an unauthenticated caller: a membership needs an account', async () => {
    const response = (await app.inject({
      method: 'POST',
      url: '/v1/invitations/acceptances',
      headers: { 'content-type': 'application/json' },
      payload: { token: 'a'.repeat(43) },
    })) as unknown as InjectedResponse;
    expect(response.statusCode).toBe(401);
  });

  it('leaves every unscoped statement named, even though it runs before any membership', async () => {
    const inviter = await signIn(owner().id);
    const { token } = await issue(inviter);
    const invitee = await signIn(outsider().id);

    guardEvents.length = 0;
    await accept(invitee, token);

    // The guard runs in `enforce` mode here. Two kinds of statement skip the tenant predicate
    // on this path — the membership resolver's read and this ticket's bootstrap read — and
    // both carry an `allowedReason`. That **no** event lacks one is the assertion: it means
    // the acceptance transaction itself, which creates a membership in an organization the
    // caller was not yet in, ran fully guarded.
    expect(guardEvents.filter((event) => !event.allowedReason)).toEqual([]);
    expect(guardEvents.some((event) => event.allowedReason?.includes('invitation token'))).toBe(
      true,
    );
  });
});

describe('a client invitation', () => {
  it('creates a client membership rather than an internal one', async () => {
    const inviter = await signIn(owner().id);
    const { token } = await issue(inviter, {
      email: 'karim.said@atlas.example',
      role: 'client_viewer',
      clientOrganizationId: world.atlas.clientOrganizationId,
    });

    const invitee = await signIn(outsider().id);
    const response = await accept(invitee, token);
    expect(response.statusCode).toBe(201);
    expect(response.json<{ clientOrganizationId: string | null }>().clientOrganizationId).toBe(
      world.atlas.clientOrganizationId,
    );

    const internal = await observe(
      'select id from memberships where organization_id = ? and user_id = ?',
      [world.northstar.organizationId, outsider().id],
    );
    expect(internal).toHaveLength(0);

    const client = await observe(
      'select status, role from client_memberships where client_organization_id = ? and user_id = ?',
      [world.atlas.clientOrganizationId, outsider().id],
    );
    expect(client).toHaveLength(1);
    expect(client[0]!['status']).toBe('active');
  });

  it('cannot name another tenant’s client organization', async () => {
    const inviter = await signIn(owner().id);
    const response = await send('POST', orgUrl('/invitations'), inviter, {
      email: 'd@example.test',
      role: 'client_viewer',
      clientOrganizationId: world.twin.projectId,
    });

    // The composite foreign key refuses it. What matters is that no row was written.
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    const rows = await observe('select id from invitations where email = ?', ['d@example.test']);
    expect(rows).toHaveLength(0);
  });
});

describe('revoking, re-issuing and expiring', () => {
  it('re-issuing revokes the old token and hands out a new one', async () => {
    const session = await signIn(owner().id);
    const first = await issue(session);

    const response = await send(
      'POST',
      orgUrl(`/invitations/${first.invitation.id}/reissues`),
      session,
      { role: 'manager' },
    );
    expect(response.statusCode).toBe(201);
    const second = response.json<Issued>();

    expect(second.invitation.id).not.toBe(first.invitation.id);
    expect(second.token).not.toBe(first.token);
    expect(second.invitation.role).toBe('manager');

    const rows = await observe('select status from invitations where id = ?', [
      first.invitation.id,
    ]);
    expect(rows[0]!['status']).toBe('revoked');

    // The old token is dead the moment the new one exists.
    const invitee = await signIn(outsider().id);
    expect((await accept(invitee, first.token)).statusCode).toBe(404);
    expect((await accept(invitee, second.token)).statusCode).toBe(201);
  });

  it('records two events for a re-issue, because two things happened', async () => {
    const session = await signIn(owner().id);
    const first = await issue(session);
    await send('POST', orgUrl(`/invitations/${first.invitation.id}/reissues`), session, {});

    const revoked = await observe(
      `select metadata_json from audit_events where action = 'invitation.revoked'`,
    );
    expect(revoked).toHaveLength(1);
    // `revocation`, not `reason` — the audit vocabulary refuses `reason` as a key, because
    // it is where prose ends up. The value is one of two classifications.
    expect(metadataOf(revoked[0]!)['revocation']).toBe('reissued');

    const issued = await observe(`select id from audit_events where action = 'invitation.issued'`);
    expect(issued).toHaveLength(2);
  });

  it('refuses to revoke something that is no longer pending', async () => {
    const session = await signIn(owner().id);
    const { invitation } = await issue(session);

    expect(
      (await send('DELETE', orgUrl(`/invitations/${invitation.id}`), session)).statusCode,
    ).toBe(200);
    expect(
      (await send('DELETE', orgUrl(`/invitations/${invitation.id}`), session)).statusCode,
    ).toBe(409);
  });

  it('sweeps overdue invitations into expired, and says how many', async () => {
    const session = await signIn(owner().id);
    const { invitation } = await issue(session);
    await db.admin.query(
      'update invitations set expires_at = date_sub(current_timestamp(3), interval 1 day) where id = ?',
      [invitation.id],
    );

    const response = await send('POST', orgUrl('/invitations/expirations'), session, {});
    expect(response.statusCode).toBe(200);
    expect(response.json<{ expired: number }>().expired).toBe(1);

    const rows = await observe('select status from invitations where id = ?', [invitation.id]);
    expect(rows[0]!['status']).toBe('expired');
  });

  it('leaves a revoked invitation revoked, rather than calling it expired', async () => {
    const session = await signIn(owner().id);
    const { invitation } = await issue(session);
    await send('DELETE', orgUrl(`/invitations/${invitation.id}`), session);
    await db.admin.query(
      'update invitations set expires_at = date_sub(current_timestamp(3), interval 1 day) where id = ?',
      [invitation.id],
    );

    await send('POST', orgUrl('/invitations/expirations'), session, {});

    // The whole reason `status` is a column and not `expires_at < now()`: a derived expiry
    // would lose the fact that a person withdrew this one.
    const rows = await observe('select status from invitations where id = ?', [invitation.id]);
    expect(rows[0]!['status']).toBe('revoked');
  });

  it('lists a tenant’s invitations and nobody else’s', async () => {
    const session = await signIn(owner().id);
    await issue(session);

    const response = await send('GET', orgUrl('/invitations?status=pending'), session);
    expect(response.statusCode).toBe(200);
    const rows = response.json<{ invitations: Invitation[] }>().invitations;
    expect(rows).toHaveLength(1);
    expect(response.body).not.toContain(world.northstar.organizationId);
  });
});
