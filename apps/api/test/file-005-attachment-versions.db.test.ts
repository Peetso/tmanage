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
import { usingLeastPrivilegeCredential } from './support/test-database.js';
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
 * FILE-005 over real HTTP — C7 (migration 0228): version history for plain attachments.
 *
 * 1. **Registry.** `attachment_versions` is a tenant table in all four places; the runtime holds
 *    INSERT only, and the trigger refuses any UPDATE.
 * 2. **A chain.** Version 1 is the root asset; each POST records the next number; any version id
 *    resolves to the same history; a second claim of the same asset is refused.
 * 3. **Only plain attachments.** A chat file or the company logo (`org_logo`) takes no versions.
 * 4. **Tenant isolation.** The twin gets a 404; the composite keys refuse a cross-tenant row.
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

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

function signIn(userId: string): Promise<Session> {
  return harnessSignIn(app, userId);
}

async function send(
  method: 'GET' | 'POST',
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

interface History {
  rootFileAssetId: string;
  versions: { versionNo: number; fileAssetId: string; note: string | null; current: boolean }[];
}

/** An uploaded, scanned file (the upload pipeline's end state). */
async function file(
  options: {
    organizationId?: string;
    projectId?: string;
    purpose?: string;
    status?: string;
    name?: string;
  } = {},
): Promise<string> {
  const id = uuidv7();
  await db.admin.execute(
    `insert into file_assets
       (id, organization_id, project_id, owner_user_id, name, purpose, object_id, audience,
        status, version)
     values (?, ?, ?, ?, ?, ?, ?, 'internal', ?, 1)`,
    [
      id,
      options.organizationId ?? world.northstar.organizationId,
      options.projectId ?? world.northstar.projectId,
      options.organizationId === world.twin.organizationId
        ? world.twin.owner.id
        : world.northstar.owner.id,
      options.name ?? 'brief.pdf',
      options.purpose ?? 'deliverable',
      uuidv7(),
      options.status ?? 'ready',
    ],
  );
  return id;
}

async function addVersion(
  session: Session,
  rootId: string,
  fileAssetId: string,
  note?: string,
  slug = NORTHSTAR,
): Promise<InjectedResponse> {
  return send(
    'POST',
    `/files/${rootId}/versions`,
    session,
    { fileAssetId, ...(note === undefined ? {} : { note }) },
    slug,
  );
}

const owner = () => world.northstar.owner;

beforeAll(async () => {
  ({ app, db } = await bootHttpHarness({ secretTag: 'the_file_005_suite', guardMode: 'enforce' }));
}, 300_000);

beforeEach(async () => {
  world = await reseed(db);
  await db.admin.query('TRUNCATE TABLE `attachment_versions`');
});

afterAll(async () => {
  await stopHarness({ app, db });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('0228 — registry: attachment_versions in all four places', () => {
  it('is in TABLES and TENANT_TABLES, and users.sql grants the runtime INSERT only', () => {
    expect(Object.keys(TABLES)).toContain('attachment_versions');
    expect(TENANT_TABLES['attachment_versions']).toBe('organization_id');
    const onTable = (user: string) =>
      [...(intents.get(`'${user}'@'%'`)?.privileges ?? [])].filter((key) =>
        key.startsWith('tmanage.attachment_versions:'),
      );
    expect(onTable('tmanage_app')).toEqual(['tmanage.attachment_versions:INSERT']);
    expect(intents.get(`'tmanage_app'@'%'`)?.privileges.has('tmanage.*:SELECT')).toBe(true);
    expect(onTable('tmanage_worker')).toEqual([]);
  });

  it.skipIf(!usingLeastPrivilegeCredential)(
    'holds no UPDATE or DELETE for the runtime credential',
    async () => {
      const grants = await observe("show grants for 'tmanage_app'@'%'");
      const line = grants
        .map((row) => String(Object.values(row)[0]))
        .find((text) => text.includes('`attachment_versions`'));
      expect(line, 'no grant names attachment_versions').toBeDefined();
      expect(line).not.toMatch(/UPDATE|DELETE/i);
    },
  );
});

describe('0228 — a version chain', () => {
  it('records versions 2 and 3, newest first, and audits each', async () => {
    const root = await file({ name: 'brief-v1.pdf' });
    const second = await file({ name: 'brief-v2.pdf' });
    const third = await file({ name: 'brief-v3.pdf' });
    const session = await signIn(owner().id);

    const two = await addVersion(session, root, second, '  Client comments applied  ');
    expect(two.statusCode, two.body).toBe(201);
    // Naming a later version resolves to the same chain.
    const three = await addVersion(session, second, third);
    expect(three.statusCode, three.body).toBe(201);

    const history = three.json<History>();
    expect(history.rootFileAssetId).toBe(root);
    expect(history.versions.map((v) => [v.versionNo, v.fileAssetId, v.current])).toEqual([
      [3, third, true],
      [2, second, false],
      [1, root, false],
    ]);
    expect(history.versions[1]!.note).toBe('Client comments applied');

    const listed = await send('GET', `/files/${third}/versions`, session);
    expect(listed.statusCode).toBe(200);
    expect(listed.json<History>().versions).toHaveLength(3);

    const rows = await observe(
      `select organization_id, project_id, version_no, created_by_user_id
         from attachment_versions where root_file_asset_id = ? order by version_no`,
      [root],
    );
    expect(rows.map((row) => Number(row['version_no']))).toEqual([2, 3]);
    expect(rows.every((row) => row['organization_id'] === world.northstar.organizationId)).toBe(
      true,
    );
    expect(rows.every((row) => row['created_by_user_id'] === owner().id)).toBe(true);

    const audits = await observe(
      `select id from audit_events where action = 'file_asset.version_added' and object_id = ?`,
      [root],
    );
    expect(audits).toHaveLength(2);
  });

  it('refuses a file already in a chain, a file of another project, and an unusable file', async () => {
    const root = await file();
    const second = await file();
    const session = await signIn(owner().id);
    expect((await addVersion(session, root, second)).statusCode).toBe(201);

    expect((await addVersion(session, root, second)).statusCode).toBe(422);
    const elsewhere = await file({ projectId: world.northstar.otherProjectId });
    expect((await addVersion(session, root, elsewhere)).statusCode).toBe(422);
    const rejected = await file({ status: 'rejected' });
    expect((await addVersion(session, root, rejected)).statusCode).toBe(422);
    const otherKind = await file({ purpose: 'document' });
    expect((await addVersion(session, root, otherKind)).statusCode).toBe(422);

    expect(await observe('select id from attachment_versions')).toHaveLength(1);
  });

  it('gives a member off the file’s project a 404', async () => {
    const root = await file({ projectId: world.northstar.otherProjectId });
    const designer = await signIn(world.northstar.designer.id);
    const response = await send('GET', `/files/${root}/versions`, designer);
    expect(response.statusCode).toBe(404);
  });
});

describe('0228 — only plain attachments take versions', () => {
  it('treats a chat file and the company logo as not found', async () => {
    const session = await signIn(owner().id);
    for (const purpose of ['message_attachment', 'org_logo']) {
      const root = await file({ purpose });
      const next = await file({ purpose });
      const listed = await send('GET', `/files/${root}/versions`, session);
      expect(listed.statusCode, purpose).toBe(404);
      expect((await addVersion(session, root, next)).statusCode, purpose).toBe(404);
    }
    expect(await observe('select id from attachment_versions')).toHaveLength(0);
  });
});

describe('0228 — tenant isolation', () => {
  it('gives the adversarial twin a 404 and writes nothing', async () => {
    const root = await file();
    const twinFile = await file({
      organizationId: world.twin.organizationId,
      projectId: world.twin.projectId,
    });
    const twin = await signIn(world.twin.owner.id);
    expect((await send('GET', `/files/${root}/versions`, twin, undefined, TWIN)).statusCode).toBe(
      404,
    );
    expect((await addVersion(twin, root, twinFile, undefined, TWIN)).statusCode).toBe(404);
    // Northstar cannot pull the twin's file into its own chain either.
    const session = await signIn(owner().id);
    expect((await addVersion(session, root, twinFile)).statusCode).toBe(422);
    expect(await observe('select id from attachment_versions')).toHaveLength(0);
  });

  it('refuses a cross-tenant row at the storage layer', async () => {
    const root = await file();
    const twinFile = await file({
      organizationId: world.twin.organizationId,
      projectId: world.twin.projectId,
    });
    await expect(
      db.admin.execute(
        `insert into attachment_versions
           (id, organization_id, project_id, root_file_asset_id, file_asset_id, version_no,
            created_by_user_id)
         values (?, ?, ?, ?, ?, 2, ?)`,
        [
          uuidv7(),
          world.northstar.organizationId,
          world.northstar.projectId,
          root,
          twinFile,
          owner().id,
        ],
      ),
    ).rejects.toThrow(/foreign key/i);
  });
});

describe('0228 — append-only', () => {
  it('refuses any UPDATE, even from the admin credential, and collides on a repeated number', async () => {
    const root = await file();
    const second = await file();
    const third = await file();
    const session = await signIn(owner().id);
    expect((await addVersion(session, root, second)).statusCode).toBe(201);

    await expect(
      db.admin.execute(
        'update attachment_versions set version_no = 9 where root_file_asset_id = ?',
        [root],
      ),
    ).rejects.toThrow(/append-only/i);

    await expect(
      db.admin.execute(
        `insert into attachment_versions
           (id, organization_id, project_id, root_file_asset_id, file_asset_id, version_no,
            created_by_user_id)
         values (?, ?, ?, ?, ?, 2, ?)`,
        [
          uuidv7(),
          world.northstar.organizationId,
          world.northstar.projectId,
          root,
          third,
          owner().id,
        ],
      ),
    ).rejects.toThrow(/duplicate/i);
  });
});
