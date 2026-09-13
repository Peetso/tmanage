import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { INTERNAL_ROLES, uuidv7 } from '@tmanage/domain';
import type { Capability, InternalRole } from '@tmanage/domain';
import { expectedCeilingGrants } from '@tmanage/test-kit';
import { AppModule } from '../src/app.module.js';
import { DatabaseModule } from '../src/common/database/database.module.js';
import { apiConfigFrom } from '../src/common/http/api-config.js';
import type { ApiConfig } from '../src/common/http/api-config.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * TEST-001's second half — `25-AUTH-AND-TENANT-ISOLATION` §11's **role** grid, generated
 * rather than sampled.
 *
 * The first half (the two-tenant seed and the adversarial pair) has run on every database
 * pass since the corpus landed, and SEC-001's grid walks the *operations* a client
 * principal can reach. What was missing is the internal side of §11's role×operation
 * matrix: for every internal role, against every capability-gated route family, does the
 * ceiling hold from **both** directions — the roles the matrix grants pass the guard, and
 * the roles it does not are refused with the audited 403 §12 demands?
 *
 * Three properties make this a harness rather than a list of examples:
 *
 * 1. **The expectation is restated, not derived.** Each cell's verdict comes from
 *    `expectedCeilingGrants(role, capability)` — `@tmanage/test-kit`'s hand-written
 *    transcription of `12-PERMISSION-MATRIX.md` §2, which imports no value from the domain
 *    and cannot see `CAPABILITY_CEILING`.
 *
 *    It used to come from `hasCapability(role, capability)`, the domain's own ceiling table,
 *    on the argument that a deliberate matrix change should move the harness with it. That
 *    was finding D18, restated as C1 by the 2026-09-12 test-honesty sweep: both sides of the
 *    comparison moved together, so the grid proved the HTTP layer agrees with the table and
 *    nothing at all about whether the table is right. Adding a capability to a role's ceiling
 *    widened the grid's own expectation and it stayed green. Now the same edit fails this
 *    file — the widened role reaches a route the transcription says it must be refused — and
 *    fails `permission-matrix-fixture.test.ts` in the unit project, which is the loud signal
 *    that a person has to decide which side is wrong.
 * 2. **Every refusal must leave the audit row.** The guard's contract is that a denied
 *    sensitive attempt is a security event; the suite counts
 *    `security.capability_denied` rows and requires exactly one per refused cell, no
 *    more, no fewer.
 * 3. **The route list is asserted against the controllers it mirrors.** Each row's
 *    capability is what `@RequireCapability` declares on that route; if a route's
 *    declaration changes, the allowed/refused split for that row changes with it while the
 *    transcription does not — so a route re-gated behind a capability its callers do not
 *    hold fails here. A route that *vanishes* fails loudly as a 404, which is a row nobody
 *    deleted on purpose.
 */

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;

const SESSION_SECRET = 'local_dev_only_session_secret_for_the_role_matrix_suite';
const CSRF_SECRET = 'local_dev_only_csrf_secret_for_the_role_matrix_suite_xx';

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

async function signIn(userId: string): Promise<Session> {
  const response = (await app.inject({
    method: 'POST',
    url: '/v1/dev/sessions',
    headers: { 'content-type': 'application/json' },
    payload: { userId },
  })) as unknown as InjectedResponse;
  return { cookie: cookieHeader(setCookies(response)) };
}

async function get(path: string, session: Session): Promise<InjectedResponse> {
  return (await app.inject({
    method: 'GET',
    url: `/v1/organizations/northstar-studio${path}`,
    headers: { cookie: session.cookie },
  })) as unknown as InjectedResponse;
}

/**
 * The grid's rows: one list-shaped GET per capability-gated route family. GETs on
 * purpose — the grid's subject is the guard, and a read needs no per-role fixtures and
 * mutates nothing between cells. The capability column mirrors each route's own
 * `@RequireCapability` declaration.
 */
const GRID: readonly { readonly path: string; readonly capability: Capability }[] = [
  { path: '/work-items', capability: 'work.read' },
  { path: '/client-requests', capability: 'client_request.triage' },
  { path: '/conversations', capability: 'conversation.read' },
  { path: '/invitations', capability: 'org.manage' },
  // INBOX-001: the inbox is guarded by `work.read` on purpose — see `InboxController`.
  { path: '/inbox', capability: 'work.read' },
];

/*
 * Two rows this grid deliberately does NOT have, recorded because each absence was a
 * finding: `/portal/requests` and, since INBOX-001's second half, `/portal/inbox` (both
 * capability `client_request.submit`). The owner and org_admin ceilings include the
 * capability, so the guard passes them — and the portal services then refuse any internal
 * principal with their own 403, because a request with no client organization is a row the
 * table cannot hold. That refusal is object-level, already proved in the REQ-001 suite and
 * in `inbox-001-portal-inbox.db.test.ts`, and exactly the layer §3 says the guard must not
 * be mistaken for ("route guards are UX only"). This harness is about the guard; a cell
 * whose allowed half is answered by a deeper layer does not belong in it. The `/portal/inbox`
 * row was written into this grid first and failed for owner and org_admin, which is the
 * finding restated by a test rather than a comment.
 */

/** One person per internal role, seeded directly — the matrix needs every column. */
const roleUsers = new Map<InternalRole, string>();

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);

  for (const role of INTERNAL_ROLES) {
    const userId = uuidv7();
    await db.admin.execute(
      `insert into users (id, email, display_name, email_verified_at)
       values (?, ?, ?, utc_timestamp(3))`,
      [userId, `${role.replace(/_/g, '-')}@matrix.northstar.example`, `Matrix ${role}`],
    );
    await db.admin.execute(
      `insert into memberships (id, organization_id, user_id, role, has_org_wide_scope)
       values (?, ?, ?, ?, ?)`,
      [
        uuidv7(),
        world.northstar.organizationId,
        userId,
        role,
        role === 'owner' || role === 'org_admin',
      ],
    );
    roleUsers.set(role, userId);
  }

  app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({
      config: CONFIG,
      database: DatabaseModule.forPool({ pool: db.runtime, guardMode: 'enforce' }),
    }),
    new FastifyAdapter(),
    { logger: false, abortOnError: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}, 300_000);

afterAll(async () => {
  await app?.close();
  await db?.stop();
});

describe('§11 role grid, internal side', () => {
  for (const role of INTERNAL_ROLES) {
    it(`'${role}' is allowed exactly the cells its ceiling grants`, async () => {
      const session = await signIn(roleUsers.get(role) as string);
      for (const cell of GRID) {
        const expected = expectedCeilingGrants(role, cell.capability);
        const response = await get(cell.path, session);
        if (expected) {
          expect(
            response.statusCode,
            `${role} should pass the guard for ${cell.path} (${cell.capability})`,
          ).not.toBe(403);
          expect(response.statusCode, `${role} → ${cell.path} should be a real route`).not.toBe(
            404,
          );
        } else {
          expect(
            response.statusCode,
            `${role} must be refused ${cell.path} (${cell.capability})`,
          ).toBe(403);
        }
      }
    });
  }

  it('every refusal in the grid left its security event, and only those', async () => {
    // One denial row per refused cell, written by the guard — §12's "denied sensitive
    // attempts are security events". The count is exact: a missing row is a silent
    // refusal, a surplus row is a phantom attempt.
    let refusals = 0;
    for (const role of INTERNAL_ROLES) {
      for (const cell of GRID) {
        if (!expectedCeilingGrants(role, cell.capability)) refusals += 1;
      }
    }
    expect(refusals).toBeGreaterThan(0);

    const rows = await observe(
      `select count(*) as n from audit_events
        where organization_id = ? and action = 'security.capability_denied'`,
      [world.northstar.organizationId],
    );
    expect(Number(rows[0]?.['n'])).toBe(refusals);
  });

  it('a client principal is refused an internal route the same way, and it is recorded', async () => {
    // The client side of §11's grid lives in SEC-001's operations corpus; this one cell
    // pins the seam between the two: an internal-only capability refused to a client role
    // takes the same audited path as an internal refusal.
    const before = await observe(
      `select count(*) as n from audit_events
        where organization_id = ? and action = 'security.capability_denied'`,
      [world.northstar.organizationId],
    );
    const session = await signIn(world.atlas.admin.id);
    const response = await get('/work-items', session);
    expect(response.statusCode).toBe(403);
    const after = await observe(
      `select count(*) as n from audit_events
        where organization_id = ? and action = 'security.capability_denied'`,
      [world.northstar.organizationId],
    );
    expect(Number(after[0]?.['n'])).toBe(Number(before[0]?.['n']) + 1);
  });
});
