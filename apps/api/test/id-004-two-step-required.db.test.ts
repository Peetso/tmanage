import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { uuidv7 } from '@tmanage/domain';
import { CSRF_HEADER } from '../src/common/http/csrf.js';
import type { TestDatabase } from './support/test-database.js';
import type { SeedWorld } from './seed-two-tenants.js';
import {
  bootHttpHarness,
  reseed,
  signIn as harnessSignIn,
  stopHarness,
} from './support/http-harness.js';
import type { InjectedResponse, Session } from './support/http-harness.js';

/**
 * ID-004 over real HTTP — C3: the company switch "Everyone must use two-step sign-in", enforced.
 *
 * 1. **No self lock-out.** An owner with no confirmed factor cannot turn the switch on (409, nothing
 *    stored); an enrolled owner can.
 * 2. **Enforced on every tenant route.** With the switch on, a member with no confirmed factor gets
 *    403 `two_step_required`; a half-finished or disabled enrolment does not count; a confirmed
 *    factor lets them through.
 * 3. **What stays open.** The person's own profile and preferences, and turning the switch off.
 * 4. **Tenant-scoped.** Northstar's switch does not reach the adversarial twin.
 * 5. **Audited.** Renaming the organization records `organization.renamed`.
 *
 * Since wave 9 (F09/F12b) the switch is set only through the owner-only `PUT …/admin/security`
 * (`enforce2fa`); the generic `PUT …/settings/require_two_step` is refused for everyone.
 */

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;

const NORTHSTAR = 'northstar-studio';
const TWIN = 'northstar-studios';

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

function signIn(userId: string): Promise<Session> {
  return harnessSignIn(app, userId);
}

async function send(
  method: 'GET' | 'PUT' | 'PATCH',
  path: string,
  session: Session,
  payload?: unknown,
  slug = NORTHSTAR,
): Promise<InjectedResponse> {
  return (await app.inject({
    method,
    url: `/v1/organizations/${slug}${path}`,
    headers: {
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      cookie: session.cookie,
      ...(method === 'GET' ? {} : { [CSRF_HEADER]: session.csrfToken }),
    },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  })) as unknown as InjectedResponse;
}

/** A TOTP factor row. `confirmed` false is a half-finished enrolment. */
async function factor(
  userId: string,
  opts: { confirmed: boolean; disabled?: boolean } = { confirmed: true },
): Promise<void> {
  await db.admin.execute(
    `insert into user_mfa_factors (id, user_id, kind, label, secret, confirmed_at, disabled_at)
     values (?, ?, 'totp', 'Phone', 'JBSWY3DPEHPK3PXP',
             case when ? then current_timestamp(3) else null end,
             case when ? then current_timestamp(3) else null end)`,
    [uuidv7(), userId, opts.confirmed ? 1 : 0, opts.disabled === true ? 1 : 0],
  );
}

async function storedSwitch(organizationId: string): Promise<string | null> {
  const rows = await observe(
    `select setting_value from org_settings
      where organization_id = ? and setting_key = 'require_two_step'`,
    [organizationId],
  );
  return rows[0] ? String(rows[0]['setting_value']) : null;
}

async function requireTwoStep(): Promise<void> {
  await factor(owner().id);
  const session = await signIn(owner().id);
  const response = await send('PUT', '/admin/security', session, { enforce2fa: true });
  expect(response.statusCode, response.body).toBe(200);
  expect(await storedSwitch(world.northstar.organizationId)).toBe('true');
}

const owner = () => world.northstar.owner;
const designer = () => world.northstar.designer;

beforeAll(async () => {
  ({ app, db } = await bootHttpHarness({ secretTag: 'the_id_004_suite', guardMode: 'enforce' }));
}, 300_000);

beforeEach(async () => {
  world = await reseed(db);
  // `org_settings` is not in `truncateAll`; the ids are fresh per seed, but start empty anyway.
  await db.admin.query('TRUNCATE TABLE `org_settings`');
});

afterAll(async () => {
  await stopHarness({ app, db });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('turning the switch on', () => {
  it('refuses an owner who has not enrolled, with nothing stored', async () => {
    const session = await signIn(owner().id);
    const response = await send('PUT', '/admin/security', session, { enforce2fa: true });
    expect(response.statusCode).toBe(409);
    expect(await storedSwitch(world.northstar.organizationId)).toBeNull();
  });

  it('lets an enrolled owner turn it on, and stay in', async () => {
    await requireTwoStep();
    const session = await signIn(owner().id);
    const response = await send('GET', '/logo', session);
    expect(response.statusCode, response.body).toBe(200);
  });
});

describe('who may set the switch (F12b)', () => {
  it('refuses the generic settings route even to the owner, with nothing stored', async () => {
    await factor(owner().id);
    const session = await signIn(owner().id);
    const response = await send('PUT', '/settings/require_two_step', session, { value: 'true' });
    expect(response.statusCode, response.body).toBe(403);
    expect(await storedSwitch(world.northstar.organizationId)).toBeNull();
  });
});

describe('enforcement', () => {
  it('answers 403 two_step_required to a member with no factor, on any tenant route', async () => {
    await requireTwoStep();
    const session = await signIn(designer().id);
    for (const path of ['/logo', '/me/privacy']) {
      const response = await send('GET', path, session);
      expect(response.statusCode, path).toBe(403);
      expect(response.json<{ error: { code: string } }>().error.code, path).toBe(
        'two_step_required',
      );
    }
  });

  it('does not count a half-finished or a disabled enrolment', async () => {
    await requireTwoStep();
    await factor(designer().id, { confirmed: false });
    await factor(designer().id, { confirmed: true, disabled: true });
    const session = await signIn(designer().id);
    expect((await send('GET', '/logo', session)).statusCode).toBe(403);
  });

  it('lets the member through once a factor is confirmed', async () => {
    await requireTwoStep();
    await factor(designer().id);
    const session = await signIn(designer().id);
    const response = await send('GET', '/logo', session);
    expect(response.statusCode, response.body).toBe(200);
  });

  it('keeps the person’s own profile reachable before they enrol', async () => {
    await requireTwoStep();
    const session = await signIn(designer().id);
    const response = await send('GET', '/me/profile', session);
    expect(response.statusCode, response.body).toBe(200);
  });

  it('lets the switch be turned off again, after which nobody is held', async () => {
    await requireTwoStep();
    const session = await signIn(owner().id);
    const off = await send('PUT', '/admin/security', session, { enforce2fa: false });
    expect(off.statusCode, off.body).toBe(200);
    expect(await storedSwitch(world.northstar.organizationId)).toBe('false');
    const member = await signIn(designer().id);
    expect((await send('GET', '/logo', member)).statusCode).toBe(200);
  });
});

describe('tenant isolation', () => {
  it('does not hold the adversarial twin’s people to Northstar’s switch', async () => {
    await requireTwoStep();
    const twin = await signIn(world.twin.owner.id);
    const response = await send('GET', '/logo', twin, undefined, TWIN);
    expect(response.statusCode, response.body).toBe(200);
    expect(await storedSwitch(world.twin.organizationId)).toBeNull();
  });
});

describe('organization audit (C3)', () => {
  it('records a rename as organization.renamed without the names', async () => {
    const session = await signIn(owner().id);
    const response = await send('PATCH', '', session, { name: 'Northstar Studio Cairo' });
    expect([200, 204]).toContain(response.statusCode);
    const audits = await observe(
      `select metadata_json from audit_events
        where organization_id = ? and action = 'organization.renamed'`,
      [world.northstar.organizationId],
    );
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0]!['metadata_json'])).not.toContain('Cairo');
  });
});
