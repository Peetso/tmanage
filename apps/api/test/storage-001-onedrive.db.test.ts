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
import { bootHttpHarness, reseed, signIn, stopHarness } from './support/http-harness.js';
import type { InjectedResponse, Session } from './support/http-harness.js';

/**
 * STORAGE-001 over real HTTP and a real database — OneDrive as company storage (migration 0236).
 *
 * 1. **Registry.** `onedrive_folders` and `onedrive_attachments` are tenant tables in all four
 *    places (schema TABLES, TENANT_TABLES, users.sql grants, the migrator's directory), and
 *    `storage_connections` has the three new NULL columns.
 * 2. **Identity pinned, tenancy enforced.** The triggers refuse re-pointing a row; an attachment
 *    naming another tenant's work item is refused by the composite foreign key.
 * 3. **One row per provider, one mode per organization.** A Google and a OneDrive row coexist;
 *    choosing one as the company's storage resets the other to `tmanage`, through either API.
 * 4. **Connect never calls Microsoft.** It answers the consent URL and the signed flow cookie.
 * No request leaves for a real Microsoft or Google endpoint anywhere in this file.
 */

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;

const HERE = dirname(fileURLToPath(import.meta.url));
const intents = parseGrantScript(
  readFileSync(resolve(HERE, '../../../scripts/db/users.sql'), 'utf8'),
);
const ENV_KEYS = [
  'MICROSOFT_CLIENT_ID',
  'MICROSOFT_CLIENT_SECRET',
  'GOOGLE_DRIVE_CLIENT_ID',
  'GOOGLE_DRIVE_CLIENT_SECRET',
] as const;
const savedEnv = new Map<string, string | undefined>();

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

async function send(
  method: 'GET' | 'PUT' | 'POST',
  path: string,
  session: Session,
  payload?: unknown,
): Promise<InjectedResponse> {
  return (await app.inject({
    method,
    url: `/v1/organizations/northstar-studio${path}`,
    headers: {
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      cookie: session.cookie,
      ...(method === 'GET' ? {} : { [CSRF_HEADER]: session.csrfToken }),
    },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  })) as unknown as InjectedResponse;
}

/** A connected row as the services would have written it (the token is never opened here). */
async function connection(provider: 'google_drive' | 'onedrive', mode: string): Promise<void> {
  await db.admin.query(
    `insert into storage_connections
       (id, organization_id, provider, storage_mode, status, refresh_token_enc, root_folder_id,
        onedrive_drive_id, updated_at, created_at)
     values (?, ?, ?, ?, 'connected', 'mfa1.1.x.y.z', 'ROOT_folder_1', ?,
             current_timestamp(3), current_timestamp(3))`,
    [
      uuidv7(),
      world.northstar.organizationId,
      provider,
      mode,
      provider === 'onedrive' ? 'drive_1' : null,
    ],
  );
}

async function modes(): Promise<Record<string, string>> {
  const rows = await observe(
    'select provider, storage_mode from storage_connections where organization_id = ?',
    [world.northstar.organizationId],
  );
  return Object.fromEntries(rows.map((row) => [row['provider'], row['storage_mode']]));
}

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  // Configured, so the routes answer; nothing below makes a call to Microsoft or Google.
  process.env['MICROSOFT_CLIENT_ID'] = 'test-microsoft-client';
  process.env['MICROSOFT_CLIENT_SECRET'] = 'test-microsoft-secret';
  process.env['GOOGLE_DRIVE_CLIENT_ID'] = 'test-google-client';
  process.env['GOOGLE_DRIVE_CLIENT_SECRET'] = 'test-google-secret';
  ({ app, db } = await bootHttpHarness({
    secretTag: 'the_storage_001_suite',
    guardMode: 'enforce',
  }));
}, 300_000);

beforeEach(async () => {
  world = await reseed(db);
  for (const table of ['onedrive_attachments', 'onedrive_folders', 'storage_connections']) {
    await db.admin.query(`delete from \`${table}\``);
  }
});

afterAll(async () => {
  await stopHarness({ app, db });
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('0236 — registry in all four places', () => {
  it('both tables are in TABLES and TENANT_TABLES, with the runtime grants and none for the worker', () => {
    const onTable = (user: string, table: string) =>
      [...(intents.get(`'${user}'@'%'`)?.privileges ?? [])]
        .filter((key) => key.startsWith(`tmanage.${table}:`))
        .sort();
    for (const table of ['onedrive_folders', 'onedrive_attachments']) {
      expect(Object.keys(TABLES)).toContain(table);
      expect(TENANT_TABLES[table]).toBe('organization_id');
      expect(onTable('tmanage_worker', table)).toEqual([]);
    }
    expect(onTable('tmanage_app', 'onedrive_folders')).toEqual(['tmanage.onedrive_folders:INSERT']);
    expect(onTable('tmanage_app', 'onedrive_attachments')).toEqual([
      'tmanage.onedrive_attachments:INSERT',
      'tmanage.onedrive_attachments:UPDATE',
    ]);
  });

  it('the migrator applied 0236: the tables exist and storage_connections has the NULL columns', async () => {
    const tables = await observe(
      `select table_name as name from information_schema.tables
        where table_schema = database() and table_name in ('onedrive_folders', 'onedrive_attachments')`,
    );
    expect(tables.map((t) => t['name']).sort()).toEqual([
      'onedrive_attachments',
      'onedrive_folders',
    ]);
    const columns = await observe(
      `select column_name as name, is_nullable as nullable from information_schema.columns
        where table_schema = database() and table_name = 'storage_connections'
          and column_name in ('onedrive_drive_id', 'onedrive_drive_name', 'granted_scopes')`,
    );
    expect(columns.map((c) => c['name']).sort()).toEqual([
      'granted_scopes',
      'onedrive_drive_id',
      'onedrive_drive_name',
    ]);
    expect(columns.every((c) => c['nullable'] === 'YES')).toBe(true);
  });
});

describe('0236 — identity pinned and tenancy enforced', () => {
  it('refuses re-pointing a folder or an attachment, and a cross-tenant attachment', async () => {
    const org = world.northstar.organizationId;
    const folderId = uuidv7();
    await db.admin.query(
      `insert into onedrive_folders (id, organization_id, drive_id, root_item_id, subject_kind,
         subject_id, item_id) values (?, ?, 'drive_1', 'ROOT_1', 'project', ?, 'FOLDER_1')`,
      [folderId, org, world.northstar.projectId],
    );
    await expect(
      db.admin.query('update onedrive_folders set organization_id = ? where id = ?', [
        world.twin.organizationId,
        folderId,
      ]),
    ).rejects.toThrow(/immutable/);

    const attachmentId = uuidv7();
    const insert = (id: string, organizationId: string) =>
      db.admin.query(
        `insert into onedrive_attachments (id, organization_id, work_item_id, drive_id, item_id,
           name, mime_type, attached_by_user_id) values (?, ?, ?, 'drive_1', 'FILE_1', 'a.pdf',
           'application/pdf', ?)`,
        [id, organizationId, world.northstar.workItemId, world.northstar.owner.id],
      );
    await insert(attachmentId, org);
    await expect(
      db.admin.query("update onedrive_attachments set item_id = 'FILE_2' where id = ?", [
        attachmentId,
      ]),
    ).rejects.toThrow(/immutable/);
    // The twin cannot point an attachment at Northstar's work item.
    await expect(insert(uuidv7(), world.twin.organizationId)).rejects.toThrow(/foreign key/i);
  });
});

describe('0236 — one row per provider, one storage mode per organization', () => {
  it('allows one Google and one OneDrive row, never two OneDrive rows', async () => {
    await connection('google_drive', 'tmanage');
    await connection('onedrive', 'tmanage');
    await expect(connection('onedrive', 'tmanage')).rejects.toThrow(/duplicate/i);
  });

  it('choosing OneDrive resets Google Drive to tmanage, and the reverse, through either API', async () => {
    await connection('google_drive', 'google_drive');
    await connection('onedrive', 'tmanage');
    const session = await signIn(app, world.northstar.owner.id);

    const toOneDrive = await send('PUT', '/integrations/onedrive/settings', session, {
      storageMode: 'onedrive',
    });
    expect(toOneDrive.statusCode, toOneDrive.body).toBe(200);
    expect(toOneDrive.json<{ storageMode: string }>().storageMode).toBe('onedrive');
    expect(await modes()).toEqual({ google_drive: 'tmanage', onedrive: 'onedrive' });
    const googleView = await send('GET', '/integrations/google-drive', session);
    expect(googleView.json<{ storageMode: string }>().storageMode).toBe('onedrive');

    const toDrive = await send('PUT', '/integrations/google-drive/settings', session, {
      storageMode: 'google_drive',
    });
    expect(toDrive.statusCode, toDrive.body).toBe(200);
    expect(await modes()).toEqual({ google_drive: 'google_drive', onedrive: 'tmanage' });

    const back = await send('PUT', '/integrations/onedrive/settings', session, {
      storageMode: 'tmanage',
    });
    expect(back.statusCode, back.body).toBe(200);
    expect(await modes()).toEqual({ google_drive: 'tmanage', onedrive: 'tmanage' });
  });

  it('a member cannot change it, and the twin never sees Northstar’s connection', async () => {
    await connection('onedrive', 'tmanage');
    const member = await signIn(app, world.northstar.designer.id);
    const refused = await send('PUT', '/integrations/onedrive/settings', member, {
      storageMode: 'onedrive',
    });
    expect(refused.statusCode).toBe(403);
    expect(await modes()).toEqual({ onedrive: 'tmanage' });
    const twin = await signIn(app, world.twin.owner.id);
    const view = (await app.inject({
      method: 'GET',
      url: '/v1/organizations/northstar-studios/integrations/onedrive',
      headers: { cookie: twin.cookie },
    })) as unknown as InjectedResponse;
    expect(view.statusCode).toBe(200);
    expect(view.json<{ oneDrive: { status: string } }>().oneDrive.status).toBe('not_connected');
  });
});

describe('0236 — connect', () => {
  it('answers Microsoft’s consent URL with PKCE and sets the signed flow cookie', async () => {
    const session = await signIn(app, world.northstar.owner.id);
    const response = await send('POST', '/integrations/onedrive/connect', session, {});
    expect(response.statusCode, response.body).toBe(200);
    const url = new URL(response.json<{ url: string }>().url);
    expect(url.origin).toBe('https://login.microsoftonline.com');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).not.toContain('Files.ReadWrite.All');
    expect(String(response.headers['set-cookie'])).toContain('tm_onedrive_flow=');
  });
});
