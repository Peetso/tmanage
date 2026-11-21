import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { uuidv7 } from '@tmanage/domain';
import { createTenantPool } from '../src/common/database/connection.js';
import { TenantDatabase, createServiceContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { HashingEmbeddingProvider } from '../src/modules/copilot/knowledge/embeddings.js';
import { KnowledgeIndexJob } from '../src/modules/copilot/knowledge/knowledge-index-job.js';
import {
  KnowledgeRepository,
  MariaDbVectorStore,
  NodeCosineVectorStore,
} from '../src/modules/copilot/knowledge/knowledge.repository.js';
import type { ChunkVectorStore } from '../src/modules/copilot/knowledge/knowledge.repository.js';
import { FileAssetsRepository } from '../src/modules/files/file-assets.repository.js';
import { RUNTIME_STATEMENT_TIMEOUT_MS, startTestDatabase } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * 62-24 (plan 62 §9 row: "retrieval-leak tests (§7); both store implementations pass the same
 * suite") on MariaDB 11.8 through the guarded TenantDatabase. FOR THE TEST PHASE (lane T did not
 * run it, laptop rule):
 *
 * 1. The index job writes passages with the file's project, embeds them (test provider) and
 *    reuses the vectors of the same bytes under a second file.
 * 2. Both stores (VECTOR exact scan, Node cosine) answer the same query with the same order, and
 *    neither returns a passage of a project outside the scope or of the twin workspace.
 * 3. The soft delete removes the file's passages in its transaction.
 */

let db: TestDatabase;
let world: SeedWorld;
let database: TenantDatabase;
let pool: Pool | undefined;
const provider = new HashingEmbeddingProvider();
const repository = new KnowledgeRepository();

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await db.admin.query<RowDataPacket[]>(sql, params);
  return result;
}

const AT = new Date('2026-11-21T08:00:00.000Z');

/** A ready, clean, promoted file whose text is already extracted. */
async function fileWithText(
  organizationId: string,
  projectId: string,
  ownerId: string,
  text: string,
  hash: string,
): Promise<string> {
  const assetId = uuidv7();
  const versionId = uuidv7();
  await db.admin.execute(
    `insert into file_assets (id, organization_id, project_id, owner_user_id, name, purpose,
       object_id, audience, status, version, created_at, updated_at)
     values (?, ?, ?, ?, 'notes.txt', 'deliverable', ?, 'internal', 'ready', 1, ?, ?)`,
    [assetId, organizationId, projectId, ownerId, uuidv7(), AT, AT],
  );
  await db.admin.execute(
    `insert into file_versions (id, organization_id, file_asset_id, version_no, object_key,
       size_bytes, declared_mime_type, detected_mime_type, content_hash, created_at)
     values (?, ?, ?, 1, ?, ?, 'text/plain', 'text/plain', ?, ?)`,
    [versionId, organizationId, assetId, `k/${versionId}`, text.length, hash, AT],
  );
  await db.admin.execute(
    `update file_versions set trust_zone = 'private', scan_verdict = 'clean', scanned_at = ?,
       scanner = 'test' where id = ?`,
    [AT, versionId],
  );
  await db.admin.execute(
    `insert ignore into ai_file_texts (id, organization_id, content_hash, mime_type, status, body,
       char_count, created_at, updated_at)
     values (?, ?, ?, 'text/plain', 'ready', ?, ?, ?, ?)`,
    [uuidv7(), organizationId, hash, text, text.length, AT, AT],
  );
  return assetId;
}

function context(organizationId: string): TenantContext {
  return createServiceContext({
    organizationId,
    correlationId: uuidv7(),
    policyVersion: 't-62-24',
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
  await db.admin.query('delete from ai_file_chunks');
  await db.admin.query('delete from ai_file_texts');
});

afterAll(async () => {
  await pool?.end();
  await db?.stop();
});

describe('62-24 knowledge on MariaDB', () => {
  it('indexes, reuses vectors of the same bytes, and both stores rank inside the scope only', async () => {
    const north = world.northstar;
    const hash = `sha256-${uuidv7()}`;
    const inProject = await fileWithText(
      north.organizationId,
      north.projectId,
      north.owner.id,
      'Invoice overdue for the client brand campaign',
      hash,
    );
    await fileWithText(
      north.organizationId,
      north.otherProjectId,
      north.owner.id,
      'Invoice overdue for the client brand campaign',
      hash,
    );
    await fileWithText(
      world.twin.organizationId,
      world.twin.projectId,
      world.twin.owner.id,
      'Invoice overdue for the client brand campaign',
      `sha256-${uuidv7()}`,
    );

    const job = new KnowledgeIndexJob(database, repository, provider, true, undefined, () => AT);
    const report = await job.pass();
    expect(report).toMatchObject({ files: 3, failed: 0 });
    expect(report.reused).toBeGreaterThan(0);

    const ctx = context(north.organizationId);
    const [query] = await provider.embed(['overdue invoice'], 'query');
    const stores: ChunkVectorStore[] = [new MariaDbVectorStore(), new NodeCosineVectorStore()];
    const answers: string[][] = [];
    for (const store of stores) {
      const hits = await database.read(ctx, (runner) =>
        store.nearest(runner, ctx, { projectIds: [north.projectId] }, query!, 10),
      );
      const fetched = await database.read(ctx, (runner) =>
        repository.fetch(
          runner,
          ctx,
          hits.map((h) => h.chunkId),
        ),
      );
      expect(
        fetched.every((c) => c.fileAssetId === inProject),
        store.name,
      ).toBe(true);
      answers.push(hits.map((h) => h.chunkId));
      expect(
        await database.read(ctx, (runner) =>
          store.nearest(runner, ctx, { projectIds: [] }, query!, 10),
        ),
      ).toEqual([]);
    }
    expect(answers[0]).toEqual(answers[1]);
    const keyword = await database.read(ctx, (runner) =>
      repository.keywordRank(runner, ctx, { projectIds: [north.projectId] }, 'campaign', 10),
    );
    expect(keyword.length).toBeGreaterThan(0);

    // The soft delete removes the file's passages in its own transaction.
    const owner = createServiceContext({
      organizationId: north.organizationId,
      correlationId: uuidv7(),
      policyVersion: 't-62-24',
    });
    await database.transaction(owner, (tx) =>
      new FileAssetsRepository().softDelete(tx, owner, inProject),
    );
    expect(
      await rows('select id from ai_file_chunks where file_asset_id = ?', [inProject]),
    ).toEqual([]);
  });
});
