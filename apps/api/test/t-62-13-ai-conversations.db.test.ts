import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import {
  createAiConversationPurgeStore,
  createWorkerDatabase,
  purgeAiConversations,
} from '@tmanage/worker';
import type { WorkerDatabase } from '@tmanage/worker';
import { createTenantPool } from '../src/common/database/connection.js';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { ApiError } from '../src/common/http/errors.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { AiConversationsService } from '../src/modules/copilot/ai-conversations.service.js';
import { RUNTIME_STATEMENT_TIMEOUT_MS, startTestDatabase } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld, SeededUser } from './seed-two-tenants.js';

/**
 * 62-13 (plan 62 §9 row) — AI conversations on MariaDB 11.8 through the real repository over a
 * guarded TenantDatabase, and the worker's retention purge over the worker pool. FOR THE TEST
 * PHASE (lane T did not run it, laptop rule):
 *
 * 1. Private to the member: another member of the same workspace (the owner included) and the twin
 *    workspace list nothing, get 404 and delete 404; the rows stay.
 * 2. Delete really deletes: no conversation row and no message row are left.
 * 3. Retention: the owner's setting is stored and audited (days only); the purge removes only
 *    conversations past their own workspace's window, with their messages, and writes one
 *    count-only platform audit row.
 */

const TABLES = ['ai_conversation_messages', 'ai_conversations', 'ai_workspace_settings'] as const;

let db: TestDatabase;
let world: SeedWorld;
let database: TenantDatabase;
let pool: Pool | undefined;
let workerDb: WorkerDatabase | undefined;

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await db.admin.query<RowDataPacket[]>(sql, params);
  return result;
}

function contextOf(
  organizationId: string,
  user: SeededUser,
  role: 'owner' | 'member',
): TenantContext {
  return createTenantContext({
    organizationId,
    userId: user.id,
    membershipId: user.membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor(role),
    policyVersion: 't-62-13',
    correlationId: uuidv7(),
  });
}

function service(at: Date): AiConversationsService {
  return new AiConversationsService({
    database,
    standing: async () => ({
      onTestList: true,
      copilotFlag: true,
      writeScope: 'read',
      poolClass: 'customers',
      runAtOnce: false,
    }),
    audit: new AuditService(database),
    now: () => at,
  });
}

async function status(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return 'ok';
  } catch (error) {
    if (error instanceof ApiError) return String(error.status);
    throw error;
  }
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
  workerDb = createWorkerDatabase({ url: db.url, connectionLimit: 2, statementTimeoutMs: 15_000 });
}, 180_000);

beforeEach(async () => {
  for (const table of TABLES) await db.admin.query(`delete from ${table}`);
});

afterAll(async () => {
  await workerDb?.end();
  await pool?.end();
  await db?.stop();
});

describe('private to the member', () => {
  it('another member and another workspace see nothing and delete nothing', async () => {
    const org = world.northstar.organizationId;
    const at = new Date('2026-11-21T10:00:00.000Z');
    const designer = contextOf(org, world.northstar.designer, 'member');
    const owner = contextOf(org, world.northstar.owner, 'owner');
    const twin = contextOf(world.twin.organizationId, world.twin.owner, 'owner');
    const conversations = service(at);
    const id = await conversations.record(designer, {
      conversationId: null,
      message: 'what is late?',
      answer: 'Two tasks.',
      taskId: uuidv7(),
      askedAt: at,
    });
    expect((await conversations.list(designer)).items.map((c) => c.id)).toEqual([id]);
    for (const other of [owner, twin]) {
      expect((await conversations.list(other)).items).toEqual([]);
      expect(await status(conversations.get(other, id))).toBe('404');
      expect(await status(conversations.delete(other, id))).toBe('404');
      expect(await conversations.history(other, id)).toBeNull();
    }
    expect(await rows('select id from ai_conversation_messages')).toHaveLength(2);
  });
});

describe('delete really deletes', () => {
  it('leaves no conversation and no message', async () => {
    const org = world.northstar.organizationId;
    const at = new Date('2026-11-21T10:00:00.000Z');
    const designer = contextOf(org, world.northstar.designer, 'member');
    const conversations = service(at);
    const id = await conversations.record(designer, {
      conversationId: null,
      message: 'hello',
      answer: 'Hi.',
      taskId: uuidv7(),
      askedAt: at,
    });
    await conversations.record(designer, {
      conversationId: id,
      message: 'and?',
      answer: 'That is all.',
      taskId: uuidv7(),
      askedAt: at,
    });
    expect((await conversations.get(designer, id)).messages).toHaveLength(4);
    await conversations.delete(designer, id);
    expect(await rows('select id from ai_conversations where id = ?', [id])).toEqual([]);
    expect(
      await rows('select id from ai_conversation_messages where conversation_id = ?', [id]),
    ).toEqual([]);
  });
});

describe('retention and purge', () => {
  it('purges only past each workspace window, messages first, one count-only audit row', async () => {
    const org = world.northstar.organizationId;
    const twinOrg = world.twin.organizationId;
    const now = new Date('2026-11-21T10:00:00.000Z');
    const day = 24 * 60 * 60 * 1000;
    const owner = contextOf(org, world.northstar.owner, 'owner');
    await service(now).setRetention(owner, 7);
    const audit = await rows(
      `select metadata_json from audit_events where organization_id = ? and action = ?`,
      [org, 'ai_conversation.retention_updated'],
    );
    expect(audit).toHaveLength(1);
    const designer = contextOf(org, world.northstar.designer, 'member');
    const twinOwner = contextOf(twinOrg, world.twin.owner, 'owner');
    const old = new Date(now.getTime() - 10 * day);
    const northstarOld = await service(old).record(designer, {
      conversationId: null,
      message: 'old',
      answer: 'old',
      taskId: uuidv7(),
      askedAt: old,
    });
    // The twin keeps the default 30 days: its 10-day-old conversation stays.
    const twinOld = await service(old).record(twinOwner, {
      conversationId: null,
      message: 'old',
      answer: 'old',
      taskId: uuidv7(),
      askedAt: old,
    });
    const result = await purgeAiConversations({
      store: createAiConversationPurgeStore(workerDb!),
      now: () => now,
    });
    expect(result.deleted).toBe(1);
    expect(await rows('select id from ai_conversations')).toEqual([{ id: twinOld }]);
    expect(
      await rows('select id from ai_conversation_messages where conversation_id = ?', [
        northstarOld,
      ]),
    ).toEqual([]);
    const platform = await rows(
      `select after_json from platform_admin_audit_events where action = 'platform.ai_conversations_purged'`,
    );
    expect(platform.length).toBeGreaterThanOrEqual(1);
  });
});
