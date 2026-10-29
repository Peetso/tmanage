import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { NestFactory } from '@nestjs/core';
import type { RowDataPacket } from 'mysql2/promise';
import { uuidv7 } from '@tmanage/domain';
import { AppModule } from '../src/app.module.js';
import { DatabaseModule } from '../src/common/database/database.module.js';
import { apiConfigFrom } from '../src/common/http/api-config.js';
import { CSRF_HEADER } from '../src/common/http/csrf.js';
import { reseed, signIn } from './support/http-harness.js';
import type { InjectedResponse, Session } from './support/http-harness.js';
import { startTestDatabase } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * PLAT-021 — the platform-admin v2 verifier's boundary proofs, over HTTP against a real server.
 *
 * 1. Isolation: a normal member of one organization still cannot read another organization —
 *    neither through the new org-side permission routes nor through the Support banner read —
 *    and is not a platform admin at all (404, the feature is invisible).
 * 2. A platform admin sees only what their platform permissions allow: every platform route
 *    needs a live step-up, and a `support` preset is refused settings, team and lifecycle.
 * 3. Every platform write lands in `platform_admin_audit_events` with before/after values.
 */

const SECRET_TAG = 'the_plat_021_verifier_boundaries_suite';
const NORTHSTAR = '/v1/organizations/northstar-studio';
const BRIGHTOPS = '/v1/organizations/brightops-consulting';

let app: NestFastifyApplication;
let db: TestDatabase;
let world: SeedWorld;
let superAdmin: Session;
let supportAdmin: Session;
let designer: Session;

async function call(
  session: Session,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
): Promise<InjectedResponse> {
  return (await app.inject({
    method,
    url,
    headers: {
      cookie: session.cookie,
      [CSRF_HEADER]: session.csrfToken,
      ...(payload ? { 'content-type': 'application/json' } : {}),
    },
    ...(payload ? { payload } : {}),
  })) as unknown as InjectedResponse;
}

async function rows(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return result;
}

function code(response: InjectedResponse): string | undefined {
  return response.json<{ error?: { code?: string } }>().error?.code;
}

beforeAll(async () => {
  db = await startTestDatabase();
  world = await reseed(db);
  const config = apiConfigFrom({
    NODE_ENV: 'test',
    ALLOW_DEV_SIGN_IN: true,
    SESSION_COOKIE_NAME: 'tmanage_session',
    SESSION_SECRET: `local_dev_only_session_secret_for_${SECRET_TAG}`.padEnd(48, 'x'),
    SESSION_TTL_SECONDS: 900,
    REFRESH_TTL_SECONDS: 1_209_600,
    CSRF_SECRET: `local_dev_only_csrf_secret_for_${SECRET_TAG}`.padEnd(48, 'x'),
    AUTH_MFA_SEED_KEYS: '1:local_dev_only_mfa_seed_key_change_me_00000',
    API_PUBLIC_URL: 'http://localhost:4000',
    AUTH_MAX_FAILURES_IN_WINDOW: 50,
    AUTH_FAILURE_WINDOW_SECONDS: 900,
    AUTH_TOTP_ISSUER: 'TManage',
    CLIENT_MEMBERSHIP_DEFAULT_EXPIRY_DAYS: 180,
    PLATFORM_ADMIN_EMAILS: world.platformAdmin.email,
  });
  expect(config.platformAdminEmails).toEqual([world.platformAdmin.email]);
  app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({
      config,
      database: DatabaseModule.forPool({ pool: db.runtime, guardMode: 'enforce' }),
    }),
    new FastifyAdapter(),
    { logger: false, abortOnError: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  // The support candidate joins the platform team on the `support` preset (a data row, P5).
  await db.admin.execute(
    `insert into platform_admins (id, user_id, preset, permissions_json, status, created_by)
     values (?, ?, 'support', null, 'active', ?)`,
    [uuidv7(), world.supportCandidate.id, world.platformAdmin.id],
  );
  superAdmin = await signIn(app, world.platformAdmin.id);
  supportAdmin = await signIn(app, world.supportCandidate.id);
  designer = await signIn(app, world.northstar.designer.id);
}, 240_000);

afterAll(async () => {
  await app?.close();
  await db?.stop();
});

describe('1 · a normal member cannot cross into another organization', () => {
  it('cannot read a membership of another organization through the new permission routes', async () => {
    const brightopsOwner = world.brightops.owner.membershipId;
    const own = await call(
      designer,
      'GET',
      `${NORTHSTAR}/people/${world.northstar.designer.membershipId}/effective-permissions`,
    );
    expect(own.statusCode).toBe(200);
    // Another tenant's membership id under the member's own slug: not found, never its data.
    const crossId = await call(
      designer,
      'GET',
      `${NORTHSTAR}/people/${brightopsOwner}/effective-permissions`,
    );
    expect(crossId.statusCode).toBe(404);
    // Another tenant's slug: no membership there, refused before any read.
    const crossSlug = await call(
      designer,
      'GET',
      `${BRIGHTOPS}/people/${brightopsOwner}/effective-permissions`,
    );
    expect([403, 404]).toContain(crossSlug.statusCode);
    expect(JSON.stringify(crossSlug.json())).not.toContain(world.brightops.owner.email);
  });

  it('cannot read another organization through the Support banner read or its role matrix', async () => {
    expect((await call(designer, 'GET', `${BRIGHTOPS}/support-session`)).statusCode).not.toBe(200);
    expect((await call(designer, 'GET', `${BRIGHTOPS}/admin/roles/matrix`)).statusCode).not.toBe(
      200,
    );
    expect((await call(designer, 'GET', `${BRIGHTOPS}/me`)).statusCode).not.toBe(200);
  });

  it('does not see Platform admin at all', async () => {
    for (const url of ['/v1/platform/me', '/v1/platform/organizations', '/v1/platform/team']) {
      expect((await call(designer, 'GET', url)).statusCode, url).toBe(404);
    }
    const enter = await call(
      designer,
      'POST',
      `/v1/platform/organizations/${world.brightops.organizationId}/support-session`,
      {},
    );
    expect(enter.statusCode).toBe(404);
  });
});

describe('2 · a platform admin sees only what their permissions allow', () => {
  it('needs a live step-up on every platform route before anything else', async () => {
    const before = await call(supportAdmin, 'GET', '/v1/platform/organizations');
    expect(before.statusCode).toBe(403);
    expect(code(before)).toBe('reauthentication_required');
    for (const session of [supportAdmin, superAdmin]) {
      const password =
        session === supportAdmin ? world.supportCandidate.password : world.platformAdmin.password;
      const stepUp = await call(session, 'POST', '/v1/platform/step-up', { password });
      expect(stepUp.statusCode).toBe(200);
    }
    expect((await call(supportAdmin, 'GET', '/v1/platform/organizations')).statusCode).toBe(200);
  });

  it('refuses a support-preset admin the settings, team and lifecycle routes', async () => {
    const refused: [method: 'GET' | 'PUT' | 'POST', url: string, body?: Record<string, unknown>][] =
      [
        ['PUT', '/v1/platform/settings/beta-banner', { on: false }],
        ['GET', '/v1/platform/team'],
        ['PUT', '/v1/platform/flags/mcp', { on: true }],
        [
          'POST',
          `/v1/platform/organizations/${world.brightops.organizationId}/suspension`,
          { reason: 'verifier probe' },
        ],
      ];
    for (const [method, url, body] of refused) {
      const response = await call(supportAdmin, method, url, body);
      expect(response.statusCode, `${method} ${url}`).toBe(403);
      expect(code(response), `${method} ${url}`).toBe('platform_permission_missing');
    }
    const [org] = await rows('select suspended_at from organizations where id = ?', [
      world.brightops.organizationId,
    ]);
    expect(org?.['suspended_at']).toBeNull();
  });

  it('still lets the support preset do what it holds (people and organization reads)', async () => {
    expect(
      (await call(supportAdmin, 'GET', `/v1/platform/people/${world.northstar.designer.id}`))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await call(
          supportAdmin,
          'GET',
          `/v1/platform/organizations/${world.northstar.organizationId}`,
        )
      ).statusCode,
    ).toBe(200);
  });
});

describe('3 · every platform write lands in the audit log with before/after', () => {
  it('records an organization profile edit with the old and new name', async () => {
    const id = world.brightops.organizationId;
    const response = await call(superAdmin, 'PATCH', `/v1/platform/organizations/${id}/profile`, {
      name: 'BrightOps Consulting Group',
    });
    expect(response.statusCode).toBe(200);
    const [row] = await rows(
      `select action, before_json, after_json, actor_user_id
         from platform_admin_audit_events where target_id = ? order by created_at desc, id desc`,
      [id],
    );
    expect(row?.['actor_user_id']).toBe(world.platformAdmin.id);
    expect(String(row?.['before_json'])).toContain('BrightOps Consulting');
    expect(String(row?.['after_json'])).toContain('BrightOps Consulting Group');
  });

  it('records a platform setting change and a person edit with before/after', async () => {
    const banner = await call(superAdmin, 'PUT', '/v1/platform/settings/beta-banner', {
      on: true,
      textEn: 'Beta',
      textAr: 'تجريبي',
    });
    expect(banner.statusCode).toBe(200);
    const person = await call(
      superAdmin,
      'PATCH',
      `/v1/platform/people/${world.northstar.designer.id}`,
      {
        displayName: 'Designer Renamed',
      },
    );
    expect(person.statusCode).toBe(200);
    const recent = await rows(
      `select action, target_id, before_json, after_json
         from platform_admin_audit_events where actor_user_id = ?
        order by created_at desc, id desc limit 5`,
      [world.platformAdmin.id],
    );
    const personRow = recent.find((row) => row['target_id'] === world.northstar.designer.id);
    expect(personRow, JSON.stringify(recent)).toBeDefined();
    expect(String(personRow?.['before_json'])).toContain(world.northstar.designer.displayName);
    expect(String(personRow?.['after_json'])).toContain('Designer Renamed');
    const settingRow = recent.find((row) => String(row['action']).includes('banner'));
    expect(settingRow, JSON.stringify(recent)).toBeDefined();
    expect(settingRow?.['before_json']).not.toBeNull();
    expect(String(settingRow?.['after_json'])).toContain('Beta');
    // Nothing the app holds can edit or remove an audit row (INSERT-only grant, 0239/0241).
    const [grant] = await rows(
      `select count(*) as n from information_schema.table_privileges
        where table_name in ('platform_admin_audit_events', 'audit_events', 'audit_event_changes')
          and privilege_type in ('UPDATE', 'DELETE') and grantee like '%tmanage_app%'`,
    );
    expect(Number(grant?.['n'])).toBe(0);
  });
});
