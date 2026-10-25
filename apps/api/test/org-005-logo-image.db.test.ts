import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
  reseed,
  signIn as harnessSignIn,
  stopHarness,
} from './support/http-harness.js';
import type { InjectedResponse, Session } from './support/http-harness.js';

/**
 * ORG-005 over real HTTP — C6 (migration 0229): the company logo, held by the organization.
 *
 * 1. **Registry.** `organization_logos` is a tenant table in all four places; the runtime holds
 *    INSERT, UPDATE and DELETE; the worker holds nothing.
 * 2. **One row per organization, no project.** Upload writes no `file_assets` row, a replace moves
 *    `version`, Remove deletes the row, and a logo set the old way (`logo_file_id`, an `org_logo`
 *    upload) is cleared by either.
 * 3. **Only checked bytes are stored.** An SVG is stored as the sanitiser's output; a PNG that is
 *    not a PNG is refused with nothing written.
 * 4. **Owner/admin only, tenant-scoped.** A member is a 403; the twin sees no logo of Northstar's.
 * 5. **Identity pinned.** The trigger refuses re-pointing a row at another organization.
 */

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;

const HERE = dirname(fileURLToPath(import.meta.url));
const intents = parseGrantScript(
  readFileSync(resolve(HERE, '../../../scripts/db/users.sql'), 'utf8'),
);

const NORTHSTAR = 'northstar-studio';
const TWIN = 'northstar-studios';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48]);

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

function signIn(userId: string): Promise<Session> {
  return harnessSignIn(app, userId);
}

async function send(
  method: 'GET' | 'PUT' | 'DELETE',
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

function upload(session: Session, mimeType: string, bytes: Buffer): Promise<InjectedResponse> {
  return send('PUT', '/logo/image', session, { mimeType, dataBase64: bytes.toString('base64') });
}

interface LogoView {
  logo: { mimeType: string; sizeBytes: number; version: number } | null;
}

async function logoRows(organizationId: string): Promise<RowDataPacket[]> {
  return observe(
    'select id, mime_type, version, content_base64 from organization_logos where organization_id = ?',
    [organizationId],
  );
}

const owner = () => world.northstar.owner;

beforeAll(async () => {
  ({ app, db } = await bootHttpHarness({ secretTag: 'the_org_005_suite', guardMode: 'enforce' }));
}, 300_000);

beforeEach(async () => {
  world = await reseed(db);
  await db.admin.query('TRUNCATE TABLE `organization_logos`');
});

afterAll(async () => {
  await stopHarness({ app, db });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('0229 — registry: organization_logos in all four places', () => {
  it('is in TABLES and TENANT_TABLES, and users.sql grants the runtime INSERT, UPDATE, DELETE', () => {
    expect(Object.keys(TABLES)).toContain('organization_logos');
    expect(TENANT_TABLES['organization_logos']).toBe('organization_id');
    const onTable = (user: string) =>
      [...(intents.get(`'${user}'@'%'`)?.privileges ?? [])]
        .filter((key) => key.startsWith('tmanage.organization_logos:'))
        .sort();
    expect(onTable('tmanage_app')).toEqual([
      'tmanage.organization_logos:DELETE',
      'tmanage.organization_logos:INSERT',
      'tmanage.organization_logos:UPDATE',
    ]);
    expect(onTable('tmanage_worker')).toEqual([]);
  });
});

describe('0229 — upload, replace, remove', () => {
  it('stores a PNG on the organization with no file asset, replaces it in place, and audits both', async () => {
    const session = await signIn(owner().id);
    const assetsBefore = (await observe('select id from file_assets')).length;

    const first = await upload(session, 'image/png', PNG);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json<LogoView>().logo).toMatchObject({
      mimeType: 'image/png',
      sizeBytes: PNG.length,
      version: 1,
    });
    expect((await observe('select id from file_assets')).length).toBe(assetsBefore);

    const second = await upload(session, 'image/png', Buffer.concat([PNG, Buffer.from([1])]));
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json<LogoView>().logo?.version).toBe(2);

    const rows = await logoRows(world.northstar.organizationId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!['version'])).toBe(2);

    const image = await send('GET', '/logo/image', session);
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toBe('image/png');
    expect(image.headers['x-content-type-options']).toBe('nosniff');

    const audits = await observe(
      `select metadata_json from audit_events
        where organization_id = ? and action = 'organization.logo_changed'`,
      [world.northstar.organizationId],
    );
    expect(audits).toHaveLength(2);
  });

  it('removes the logo, and a member then reads no logo', async () => {
    const session = await signIn(owner().id);
    expect((await upload(session, 'image/png', PNG)).statusCode).toBe(200);
    const removed = await send('DELETE', '/logo/image', session);
    expect(removed.statusCode, removed.body).toBe(200);
    expect(await logoRows(world.northstar.organizationId)).toHaveLength(0);

    const member = await signIn(world.northstar.designer.id);
    const info = await send('GET', '/logo', member);
    expect(info.statusCode).toBe(200);
    expect(info.json<LogoView>().logo).toBeNull();
    expect((await send('GET', '/logo/image', member)).statusCode).toBe(404);
  });

  it('clears a logo set the old way (an org_logo upload) when a new one is stored', async () => {
    const fileId = uuidv7();
    await db.admin.execute(
      `insert into file_assets
         (id, organization_id, project_id, owner_user_id, name, purpose, object_id, audience,
          status, version)
       values (?, ?, ?, ?, 'logo.png', 'org_logo', ?, 'internal', 'ready', 1)`,
      [fileId, world.northstar.organizationId, world.northstar.projectId, owner().id, uuidv7()],
    );
    await db.admin.execute('update organizations set logo_file_id = ? where id = ?', [
      fileId,
      world.northstar.organizationId,
    ]);

    const session = await signIn(owner().id);
    expect((await upload(session, 'image/png', PNG)).statusCode).toBe(200);
    const [org] = await observe('select logo_file_id from organizations where id = ?', [
      world.northstar.organizationId,
    ]);
    expect(org!['logo_file_id']).toBeNull();
  });
});

describe('0229 — only checked bytes are stored', () => {
  it('stores the sanitised SVG, never the script that was sent', async () => {
    const session = await signIn(owner().id);
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)">' +
      '<script>alert(2)</script><rect width="10" height="10" fill="#0a7"/></svg>';
    const response = await upload(session, 'image/svg+xml', Buffer.from(svg, 'utf8'));
    expect(response.statusCode, response.body).toBe(200);

    const [row] = await logoRows(world.northstar.organizationId);
    const stored = Buffer.from(String(row!['content_base64']), 'base64').toString('utf8');
    expect(row!['mime_type']).toBe('image/svg+xml');
    expect(stored).toContain('<rect');
    expect(stored).not.toMatch(/script|onload|alert/i);
  });

  it('refuses markup declared as a PNG, with nothing written', async () => {
    const session = await signIn(owner().id);
    const response = await upload(
      session,
      'image/png',
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    );
    expect(response.statusCode).toBe(400);
    expect(await logoRows(world.northstar.organizationId)).toHaveLength(0);
  });
});

describe('0229 — who may change it, and tenant isolation', () => {
  it('refuses a member without org.manage, with nothing written', async () => {
    const member = await signIn(world.northstar.designer.id);
    const response = await upload(member, 'image/png', PNG);
    expect(response.statusCode).toBe(403);
    expect(await logoRows(world.northstar.organizationId)).toHaveLength(0);
  });

  it('never shows Northstar’s logo to the adversarial twin', async () => {
    const session = await signIn(owner().id);
    expect((await upload(session, 'image/png', PNG)).statusCode).toBe(200);
    const twin = await signIn(world.twin.owner.id);
    const info = await send('GET', '/logo', twin, undefined, TWIN);
    expect(info.statusCode).toBe(200);
    expect(info.json<LogoView>().logo).toBeNull();
    expect((await send('GET', '/logo/image', twin, undefined, TWIN)).statusCode).toBe(404);
    // And the twin's Remove touches only its own (absent) row.
    expect((await send('DELETE', '/logo/image', twin, undefined, TWIN)).statusCode).toBe(200);
    expect(await logoRows(world.northstar.organizationId)).toHaveLength(1);
  });
});

describe('0229 — identity is pinned at the engine', () => {
  it('refuses re-pointing a logo at another organization, and a second row for one organization', async () => {
    const session = await signIn(owner().id);
    expect((await upload(session, 'image/png', PNG)).statusCode).toBe(200);

    await expect(
      db.admin.execute(
        'update organization_logos set organization_id = ? where organization_id = ?',
        [world.twin.organizationId, world.northstar.organizationId],
      ),
    ).rejects.toThrow(/immutable/i);

    await expect(
      db.admin.execute(
        `insert into organization_logos
           (id, organization_id, mime_type, size_bytes, sha256, content_base64, updated_by)
         values (?, ?, 'image/png', 1, ?, 'AA==', ?)`,
        [uuidv7(), world.northstar.organizationId, 'a'.repeat(64), owner().id],
      ),
    ).rejects.toThrow(/duplicate/i);
    expect(await logoRows(world.twin.organizationId)).toHaveLength(0);
  });
});
