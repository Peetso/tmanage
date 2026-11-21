import { Readable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { uuidv7 } from '@tmanage/domain';
import { createTenantPool } from '../src/common/database/connection.js';
import { TenantDatabase } from '../src/common/database/tenant-context.js';
import { FileAssetsRepository } from '../src/modules/files/file-assets.repository.js';
import { DEFAULT_FILE_TEXT_JOB_OPTIONS, FileTextJob } from '../src/modules/files/file-text-job.js';
import { FileTextsRepository } from '../src/modules/files/file-texts.repository.js';
import { RUNTIME_STATEMENT_TIMEOUT_MS, startTestDatabase } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * 62-23 (plan 62 §9 row: "only scan-clean files; cap and timeout; same hash extracted once") —
 * the text job's SQL on MariaDB 11.8 through the guarded TenantDatabase, with an in-memory object
 * store. FOR THE TEST PHASE (lane T did not run it, laptop rule):
 *
 * 1. Only servable versions are planned: an unscanned or quarantined version gets no row.
 * 2. One row per (workspace, content hash): two clean versions with the same hash are read once;
 *    the twin workspace's file with the same bytes gets its own row (never shared).
 * 3. A deleted file's text is forgotten on the next pass.
 */

const BODIES = new Map<string, string>();

let db: TestDatabase;
let world: SeedWorld;
let database: TenantDatabase;
let pool: Pool | undefined;
const opened: string[] = [];

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await db.admin.query<RowDataPacket[]>(sql, params);
  return result;
}

async function file(
  organizationId: string,
  projectId: string,
  ownerId: string,
  body: string,
  hash: string,
  scan: 'clean' | 'unscanned' = 'clean',
): Promise<{ assetId: string; versionId: string }> {
  const assetId = uuidv7();
  const versionId = uuidv7();
  const objectKey = `tenant/${organizationId}/${versionId}`;
  BODIES.set(objectKey, body);
  await db.admin.execute(
    `insert into file_assets
       (id, organization_id, project_id, owner_user_id, name, purpose, object_id, audience,
        status, version, created_at, updated_at)
     values (?, ?, ?, ?, 'brief.txt', 'deliverable', ?, 'internal', ?, 1, ?, ?)`,
    [
      assetId,
      organizationId,
      projectId,
      ownerId,
      uuidv7(),
      scan === 'clean' ? 'ready' : 'scanning',
      new Date('2026-11-21T08:00:00.000Z'),
      new Date('2026-11-21T08:00:00.000Z'),
    ],
  );
  await db.admin.execute(
    `insert into file_versions
       (id, organization_id, file_asset_id, version_no, object_key, size_bytes,
        declared_mime_type, detected_mime_type, content_hash, created_at)
     values (?, ?, ?, 1, ?, ?, 'text/plain', 'text/plain', ?, ?)`,
    [
      versionId,
      organizationId,
      assetId,
      objectKey,
      Buffer.byteLength(body),
      hash,
      new Date('2026-11-21T08:00:00.000Z'),
    ],
  );
  if (scan === 'clean') {
    await db.admin.execute(
      `update file_versions set trust_zone = 'private', scan_verdict = 'clean', scanned_at = ?, scanner = 'test' where id = ?`,
      [new Date('2026-11-21T08:01:00.000Z'), versionId],
    );
  } else {
    await db.admin.execute(`update file_versions set scan_verdict = 'unscanned' where id = ?`, [
      versionId,
    ]);
  }
  return { assetId, versionId };
}

function job(): FileTextJob {
  const store = {
    openObject: ({ objectKey }: { objectKey: string }) => {
      opened.push(objectKey);
      const body = BODIES.get(objectKey) ?? '';
      return Promise.resolve({
        sizeBytes: Buffer.byteLength(body),
        stream: Readable.from([Buffer.from(body)]),
      });
    },
  };
  return new FileTextJob(
    database,
    new FileTextsRepository(),
    new FileAssetsRepository(),
    store as never,
    true,
    { ...DEFAULT_FILE_TEXT_JOB_OPTIONS, log: () => undefined },
    () => new Date('2026-11-21T09:00:00.000Z'),
  );
}

beforeAll(async () => {
  db = await startTestDatabase();
  world = await seedTwoTenants(db.admin);
  pool = createTenantPool({
    url: db.runtimeUrl,
    connectionLimit: 4,
    statementTimeoutMs: RUNTIME_STATEMENT_TIMEOUT_MS,
  });
  database = new TenantDatabase(pool, { guardMode: 'enforce' });
}, 180_000);

beforeEach(async () => {
  await db.admin.query('delete from ai_file_texts');
  opened.length = 0;
});

afterAll(async () => {
  await pool?.end();
  await db?.stop();
});

describe('62-23 text job on MariaDB', () => {
  it('reads only clean files, once per workspace and hash, never shared across workspaces', async () => {
    const north = world.northstar;
    const hash = `sha256-${uuidv7()}`;
    const a = await file(north.organizationId, north.projectId, north.owner.id, 'Q3 brief', hash);
    await file(north.organizationId, north.projectId, north.owner.id, 'Q3 brief', hash);
    await file(
      north.organizationId,
      north.projectId,
      north.owner.id,
      'not yet scanned',
      `sha256-${uuidv7()}`,
      'unscanned',
    );
    const twin = world.twin;
    await file(twin.organizationId, twin.projectId, twin.owner.id, 'Q3 brief', hash);

    const report = await job().pass();
    expect(report).toMatchObject({ ready: 2, failed: 0 });
    const texts = await rows(
      'select organization_id, content_hash, status, body from ai_file_texts order by organization_id',
    );
    expect(texts.map((t) => [t['organization_id'], t['status'], t['body']])).toEqual(
      [
        [north.organizationId, 'ready', 'Q3 brief'],
        [twin.organizationId, 'ready', 'Q3 brief'],
      ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    );
    // One read per workspace for the shared hash; the unscanned file never opened.
    expect(opened).toHaveLength(2);
    expect(opened.some((key) => BODIES.get(key) === 'not yet scanned')).toBe(false);

    // Deleting every Northstar file with that hash forgets its text there, not in the twin.
    await db.admin.execute(
      `update file_assets set deleted_at = ? where organization_id = ? and name = 'brief.txt'`,
      [new Date('2026-11-21T09:30:00.000Z'), north.organizationId],
    );
    expect(await job().pass()).toMatchObject({ forgotten: 1 });
    const left = await rows('select organization_id from ai_file_texts');
    expect(left.map((t) => t['organization_id'])).toEqual([twin.organizationId]);
    expect(a.assetId).toBeTruthy();
  });
});
