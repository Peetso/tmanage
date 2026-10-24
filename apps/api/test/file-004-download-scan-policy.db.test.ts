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
 * FILE-004 over real HTTP — B3: "Downloads before a virus scan", the company owner's setting.
 *
 * 1. **Only the owner writes it.** An org_admin holds `org.manage` and is still a 403 with no
 *    write; a manager is refused at the capability; the generic settings PUT refuses the key for
 *    everyone, the owner included, so the owner-only route is the single writer.
 * 2. **The change and its audit row commit together**, previous and new value.
 * 3. **Without a scanner the effective value is `allow_labeled`**, whatever is stored.
 * 4. **Tenant isolation.** The twin's owner sets the twin's policy and nobody else's.
 */

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;

const NORTHSTAR = 'northstar-studio';
const TWIN = 'northstar-studios';
const KEY = 'downloads_before_scan';

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

function signIn(userId: string): Promise<Session> {
  return harnessSignIn(app, userId);
}

async function send(
  method: 'GET' | 'PATCH' | 'PUT',
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

interface PolicyView {
  downloadsBeforeScan: string;
  effective: string;
  scannerConfigured: boolean;
}

async function storedFor(organizationId: string): Promise<string | undefined> {
  const rows = await observe(
    'select setting_value from org_settings where organization_id = ? and setting_key = ?',
    [organizationId, KEY],
  );
  return rows[0] === undefined ? undefined : String(rows[0]['setting_value']);
}

async function policyAudits(organizationId: string): Promise<RowDataPacket[]> {
  return observe(
    `select actor_user_id, metadata_json from audit_events
      where organization_id = ? and action = 'organization.download_scan_policy_changed'`,
    [organizationId],
  );
}

/** An org_admin in Northstar: holds `org.manage`, is not the owner. */
async function orgAdmin(): Promise<string> {
  const userId = uuidv7();
  await db.admin.execute(
    'insert into users (id, email, display_name, email_verified_at) values (?, ?, ?, now(3))',
    [userId, 'org.admin@northstar.example.test', 'Org Admin'],
  );
  await db.admin.execute(
    `insert into memberships (id, organization_id, user_id, role, has_org_wide_scope)
     values (?, ?, ?, 'org_admin', 1)`,
    [uuidv7(), world.northstar.organizationId, userId],
  );
  return userId;
}

beforeAll(async () => {
  ({ app, db } = await bootHttpHarness({ secretTag: 'the_file_004_suite', guardMode: 'enforce' }));
}, 300_000);

beforeEach(async () => {
  world = await reseed(db);
});

afterAll(async () => {
  await stopHarness({ app, db });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the owner', () => {
  it('reads the default, then sets block, with one audit row naming both values', async () => {
    const session = await signIn(world.northstar.owner.id);

    const before = await send('GET', '/file-download-policy', session);
    expect(before.statusCode).toBe(200);
    expect(before.json<PolicyView>()).toEqual({
      downloadsBeforeScan: 'allow_labeled',
      effective: 'allow_labeled',
      scannerConfigured: false,
    });

    const changed = await send('PATCH', '/file-download-policy', session, {
      downloadsBeforeScan: 'block',
    });
    expect(changed.statusCode).toBe(200);
    // No scanner in this harness: what downloads obey stays allow_labeled.
    expect(changed.json<PolicyView>()).toEqual({
      downloadsBeforeScan: 'block',
      effective: 'allow_labeled',
      scannerConfigured: false,
    });
    expect(await storedFor(world.northstar.organizationId)).toBe('block');

    const audits = await policyAudits(world.northstar.organizationId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!['actor_user_id']).toBe(world.northstar.owner.id);
    const raw = audits[0]!['metadata_json'];
    const metadata = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
    expect(metadata).toMatchObject({ previous: 'allow_labeled', value: 'block' });
  });

  it('refuses a value off the allowlist, and writes nothing', async () => {
    const session = await signIn(world.northstar.owner.id);
    const response = await send('PATCH', '/file-download-policy', session, {
      downloadsBeforeScan: 'allow_everything',
    });
    expect(response.statusCode).toBe(400);
    expect(await storedFor(world.northstar.organizationId)).toBeUndefined();
    expect(await policyAudits(world.northstar.organizationId)).toHaveLength(0);
  });

  it('cannot write the key through the generic settings PUT', async () => {
    const session = await signIn(world.northstar.owner.id);
    const response = await send('PUT', `/settings/${KEY}`, session, { value: 'block' });
    expect(response.statusCode).toBe(403);
    expect(await storedFor(world.northstar.organizationId)).toBeUndefined();
  });
});

describe('everyone who is not the owner', () => {
  it('refuses an org_admin, who holds org.manage, with a 403 and no write', async () => {
    const adminId = await orgAdmin();
    const session = await signIn(adminId);

    // The read is org.manage, so the org_admin may look...
    expect((await send('GET', '/file-download-policy', session)).statusCode).toBe(200);
    // ...but not change it, on either route.
    const patched = await send('PATCH', '/file-download-policy', session, {
      downloadsBeforeScan: 'block',
    });
    expect(patched.statusCode).toBe(403);
    const put = await send('PUT', `/settings/${KEY}`, session, { value: 'block' });
    expect(put.statusCode).toBe(403);

    expect(await storedFor(world.northstar.organizationId)).toBeUndefined();
    expect(await policyAudits(world.northstar.organizationId)).toHaveLength(0);
  });

  it('refuses a manager and a member, and writes nothing', async () => {
    for (const user of [world.northstar.manager, world.northstar.designer]) {
      const session = await signIn(user.id);
      const response = await send('PATCH', '/file-download-policy', session, {
        downloadsBeforeScan: 'block',
      });
      expect(response.statusCode).toBe(403);
    }
    expect(await storedFor(world.northstar.organizationId)).toBeUndefined();
  });

  it('refuses a client principal', async () => {
    const session = await signIn(world.atlas.admin.id);
    const response = await send('PATCH', '/file-download-policy', session, {
      downloadsBeforeScan: 'block',
    });
    expect(response.statusCode).toBe(403);
    expect(await storedFor(world.northstar.organizationId)).toBeUndefined();
  });
});

describe('tenant isolation', () => {
  it('lets the twin’s owner set the twin’s policy and touches nothing of Northstar’s', async () => {
    const twin = await signIn(world.twin.owner.id);
    const response = await send(
      'PATCH',
      '/file-download-policy',
      twin,
      { downloadsBeforeScan: 'block' },
      TWIN,
    );
    expect(response.statusCode).toBe(200);
    expect(await storedFor(world.twin.organizationId)).toBe('block');
    expect(await storedFor(world.northstar.organizationId)).toBeUndefined();
    expect(await policyAudits(world.northstar.organizationId)).toHaveLength(0);

    const northstar = await signIn(world.northstar.owner.id);
    const read = await send('GET', '/file-download-policy', northstar);
    expect(read.json<PolicyView>().downloadsBeforeScan).toBe('allow_labeled');
  });

  it('refuses the twin’s owner on Northstar’s slug, where they have no membership', async () => {
    const twin = await signIn(world.twin.owner.id);
    const response = await send('PATCH', '/file-download-policy', twin, {
      downloadsBeforeScan: 'block',
    });
    expect([403, 404]).toContain(response.statusCode);
    expect(await storedFor(world.northstar.organizationId)).toBeUndefined();
  });
});
