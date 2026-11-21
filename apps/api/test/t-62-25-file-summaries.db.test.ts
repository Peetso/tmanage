import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { uuidv7 } from '@tmanage/domain';
import { createTenantPool } from '../src/common/database/connection.js';
import { TenantDatabase, createServiceContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { FileKnowledgeRepository } from '../src/modules/copilot/knowledge/file-knowledge.repository.js';
import { KNOWLEDGE_INDEX_REASON } from '../src/modules/copilot/knowledge/knowledge-index-job.js';
import { KnowledgeRepository } from '../src/modules/copilot/knowledge/knowledge.repository.js';
import { RUNTIME_STATEMENT_TIMEOUT_MS, startTestDatabase } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * 62-25 (plan 62 §4.5: "file summary cached per content hash and audience; never shared across
 * workspaces") on MariaDB 11.8 through the guarded TenantDatabase. FOR THE TEST PHASE (lane T did
 * not run it, laptop rule):
 *
 * 1. `read` finds the current version's text row and the summary of its bytes for the file's
 *    audience only; a second file with the same bytes reads the same summary (paid once).
 * 2. `upsertSummary` keys by the text row's hash: a repeat replaces the row, never a second one;
 *    a text row of the twin workspace is not found (nothing written).
 * 3. Once the text row is gone, `deleteOrphanSummaries` removes the summary; the twin's stays.
 */

let db: TestDatabase;
let world: SeedWorld;
let database: TenantDatabase;
let pool: Pool | undefined;
const files = new FileKnowledgeRepository();
const knowledge = new KnowledgeRepository();

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await db.admin.query<RowDataPacket[]>(sql, params);
  return result;
}

const AT = new Date('2026-11-21T08:00:00.000Z');

/** A ready, clean, promoted file whose text is extracted; returns the asset and text row ids. */
async function fileWithText(
  organizationId: string,
  projectId: string,
  ownerId: string,
  hash: string,
  audience: 'internal' | 'client_visible' = 'internal',
): Promise<{ assetId: string; textId: string }> {
  const assetId = uuidv7();
  const versionId = uuidv7();
  await db.admin.execute(
    `insert into file_assets (id, organization_id, project_id, owner_user_id, name, purpose,
       object_id, audience, status, version, created_at, updated_at)
     values (?, ?, ?, ?, 'contract.txt', 'deliverable', ?, ?, 'ready', 1, ?, ?)`,
    [assetId, organizationId, projectId, ownerId, uuidv7(), audience, AT, AT],
  );
  await db.admin.execute(
    `insert into file_versions (id, organization_id, file_asset_id, version_no, object_key,
       size_bytes, declared_mime_type, detected_mime_type, content_hash, created_at)
     values (?, ?, ?, 1, ?, 10, 'text/plain', 'text/plain', ?, ?)`,
    [versionId, organizationId, assetId, `k/${versionId}`, hash, AT],
  );
  await db.admin.execute(
    `update file_versions set trust_zone = 'private', scan_verdict = 'clean', scanned_at = ?,
       scanner = 'test' where id = ?`,
    [AT, versionId],
  );
  await db.admin.execute(
    `insert ignore into ai_file_texts (id, organization_id, content_hash, mime_type, status, body,
       char_count, created_at, updated_at)
     values (?, ?, ?, 'text/plain', 'ready', 'Notice: thirty days.', 20, ?, ?)`,
    [uuidv7(), organizationId, hash, AT, AT],
  );
  const [text] = await rows(
    'select id from ai_file_texts where organization_id = ? and content_hash = ?',
    [organizationId, hash],
  );
  return { assetId, textId: String(text?.['id']) };
}

function context(organizationId: string): TenantContext {
  return createServiceContext({
    organizationId,
    correlationId: uuidv7(),
    policyVersion: 't-62-25',
  });
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
  await db.admin.query('delete from ai_file_summaries');
  await db.admin.query('delete from ai_file_texts');
});

afterAll(async () => {
  await pool?.end();
  await db?.stop();
});

describe('62-25 file summaries on MariaDB', () => {
  it('keys a summary by bytes and audience: the same bytes read it once, another audience not', async () => {
    const north = world.northstar;
    const ctx = context(north.organizationId);
    const hash = `sha256-${uuidv7()}`;
    const first = await fileWithText(north.organizationId, north.projectId, north.owner.id, hash);
    const copy = await fileWithText(
      north.organizationId,
      north.otherProjectId,
      north.owner.id,
      hash,
    );
    const forClient = await fileWithText(
      north.organizationId,
      north.projectId,
      north.owner.id,
      hash,
      'client_visible',
    );
    expect(copy.textId).toBe(first.textId);

    const saved = await database.transaction(ctx, (tx) =>
      files.upsertSummary(
        tx,
        ctx,
        { textId: first.textId, audience: 'internal', summary: 'One.', model: 'claude-haiku-5-5' },
        AT,
      ),
    );
    expect(saved).toBe(true);
    await database.transaction(ctx, (tx) =>
      files.upsertSummary(
        tx,
        ctx,
        { textId: first.textId, audience: 'internal', summary: 'Two.', model: 'claude-haiku-5-5' },
        AT,
      ),
    );
    expect(await rows('select summary from ai_file_summaries')).toEqual([{ summary: 'Two.' }]);

    const readCopy = await database.read(ctx, (db) => files.read(db, ctx, copy.assetId));
    expect(readCopy).toMatchObject({
      contentHash: hash,
      text: { id: first.textId, status: 'ready' },
      summary: { summary: 'Two.' },
    });
    const readClient = await database.read(ctx, (db) => files.read(db, ctx, forClient.assetId));
    expect(readClient?.summary).toBeNull();
  });

  it('never writes against another workspace’s text row', async () => {
    const twin = world.twin;
    const theirs = await fileWithText(
      twin.organizationId,
      twin.projectId,
      twin.owner.id,
      `sha256-${uuidv7()}`,
    );
    const ctx = context(world.northstar.organizationId);
    const saved = await database.transaction(ctx, (tx) =>
      files.upsertSummary(
        tx,
        ctx,
        { textId: theirs.textId, audience: 'internal', summary: 'Leak?', model: 'm' },
        AT,
      ),
    );
    expect(saved).toBe(false);
    expect(await rows('select id from ai_file_summaries')).toEqual([]);
  });

  it('a summary goes once no text row holds its bytes; the twin workspace’s stays', async () => {
    const north = world.northstar;
    const twin = world.twin;
    const ours = await fileWithText(
      north.organizationId,
      north.projectId,
      north.owner.id,
      `sha256-${uuidv7()}`,
    );
    const theirs = await fileWithText(
      twin.organizationId,
      twin.projectId,
      twin.owner.id,
      `sha256-${uuidv7()}`,
    );
    for (const [org, textId] of [
      [north.organizationId, ours.textId],
      [twin.organizationId, theirs.textId],
    ] as const) {
      const ctx = context(org);
      await database.transaction(ctx, (tx) =>
        files.upsertSummary(
          tx,
          ctx,
          { textId, audience: 'internal', summary: 'S.', model: 'm' },
          AT,
        ),
      );
    }
    await db.admin.execute('delete from ai_file_texts where id = ?', [ours.textId]);
    const discovered = await database.bootstrapRead(
      {
        correlationId: uuidv7(),
        reason: KNOWLEDGE_INDEX_REASON,
        tables: [
          'file_assets',
          'file_versions',
          'ai_file_texts',
          'ai_file_chunks',
          'ai_file_summaries',
        ],
      },
      (runner) => knowledge.organizationsWithWork(runner),
    );
    expect(discovered).toContain(north.organizationId);
    const ctx = context(north.organizationId);
    const deleted = await database.transaction(ctx, (tx) =>
      knowledge.deleteOrphanSummaries(tx, ctx, 100),
    );
    expect(deleted).toBe(1);
    expect(await rows('select organization_id from ai_file_summaries')).toEqual([
      { organization_id: twin.organizationId },
    ]);
  });
});
