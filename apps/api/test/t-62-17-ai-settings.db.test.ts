import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import { createTenantPool } from '../src/common/database/connection.js';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { ApiError } from '../src/common/http/errors.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { AiAllowanceService } from '../src/modules/billing/ai-allowance.service.js';
import { databaseStanding } from '../src/modules/copilot/copilot-chat.adapters.js';
import {
  AI_SETTINGS_MEMBER_BLOCKED_AUDIT_ACTION,
  AI_SETTINGS_UPDATED_AUDIT_ACTION,
  AiSettingsService,
} from '../src/modules/copilot/ai-settings.service.js';
import { RUNTIME_STATEMENT_TIMEOUT_MS, startTestDatabase } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld, SeededUser } from './seed-two-tenants.js';

/**
 * 62-17 (plan 62 J1) — Settings > AI on MariaDB 11.8 through the real repository over a guarded
 * TenantDatabase (migration 0403). FOR THE TEST PHASE (lane T did not run it, laptop rule):
 *
 * 1. Absent off the test list: GET and PATCH are 404, nothing is written.
 * 2. A change is stored and audited in the same transaction: one `ai_settings.updated` row with
 *    one `audit_event_changes` row per changed setting; the twin workspace is untouched.
 * 3. Blocking: the twin's membership id is 404 and the whole PATCH rolls back (the settings
 *    change in the same body is not kept, no audit row); a blocked member reads `memberBlocked`
 *    in the chat standing, and "Allow again" deletes the row.
 * 4. The chat standing reads the switch and "let AI read files" from the row (0403 default on).
 */

const TABLES = ['ai_member_blocks', 'ai_workspace_settings'] as const;

let db: TestDatabase;
let world: SeedWorld;
let database: TenantDatabase;
let pool: Pool | undefined;

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
    policyVersion: 't-62-17',
    correlationId: uuidv7(),
  });
}

async function listed(organizationId: string): Promise<void> {
  const at = new Date('2026-11-22T08:00:00.000Z');
  await db.admin.query(
    `insert into ai_workspace_settings (id, organization_id, test_list_at, pool_class, created_at, updated_at)
     values (?, ?, ?, 'customers', ?, ?)`,
    [uuidv7(), organizationId, at, at, at],
  );
}

function service(): AiSettingsService {
  return new AiSettingsService({
    database,
    audit: new AuditService(database),
    allowance: new AiAllowanceService({ database, poolCapMicroUsd: async () => 3_000_000_000 }),
    now: () => new Date('2026-11-22T09:00:00.000Z'),
  });
}

async function status(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return 'ok';
  } catch (error) {
    if (error instanceof ApiError)
      return `${String(error.status)} ${error.auditCode ?? error.code}`;
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
}, 180_000);

beforeEach(async () => {
  for (const table of TABLES) await db.admin.query(`delete from ${table}`);
});

afterAll(async () => {
  await pool?.end();
  await db?.stop();
});

describe('absent off the test list', () => {
  it('GET and PATCH are 404 and nothing is written', async () => {
    const owner = contextOf(world.northstar.organizationId, world.northstar.owner, 'owner');
    expect(await status(service().view(owner))).toBe('404 copilot.settings:not_on_test_list');
    expect(await status(service().update(owner, { aiEnabled: true }))).toBe(
      '404 copilot.settings:not_on_test_list',
    );
    expect(await rows('select id from ai_workspace_settings')).toEqual([]);
  });
});

describe('a change is stored and audited together', () => {
  it('one audit row and one change row per setting; the twin is untouched', async () => {
    await listed(world.northstar.organizationId);
    await listed(world.twin.organizationId);
    const owner = contextOf(world.northstar.organizationId, world.northstar.owner, 'owner');
    const view = await service().update(owner, {
      aiEnabled: true,
      fileReading: false,
      conversationRetentionDays: 90,
    });
    expect(view).toMatchObject({
      aiEnabled: true,
      fileReading: false,
      conversationRetentionDays: 90,
    });
    const stored = await rows(
      'select organization_id, ai_enabled, file_reading, conversation_retention_days from ai_workspace_settings',
    );
    expect(stored).toHaveLength(2);
    expect(stored.find((r) => r['organization_id'] === world.twin.organizationId)).toMatchObject({
      ai_enabled: 0,
      file_reading: 1,
      conversation_retention_days: 30,
    });
    const events = await rows(
      `select e.id from audit_events e where e.organization_id = ? and e.action = ?`,
      [world.northstar.organizationId, AI_SETTINGS_UPDATED_AUDIT_ACTION],
    );
    expect(events).toHaveLength(1);
    const changes = await rows(
      'select field from audit_event_changes where audit_event_id = ? order by field',
      [events[0]!['id']],
    );
    expect(changes.map((c) => c['field'])).toEqual([
      'aiEnabled',
      'conversationRetentionDays',
      'fileReading',
    ]);
    const standing = await databaseStanding(database)(owner);
    expect(standing).toMatchObject({ aiEnabled: true, fileReading: false, memberBlocked: false });
  });
});

describe('the block list', () => {
  it("the twin's member is 404 and rolls the whole patch back; a blocked member reads blocked", async () => {
    await listed(world.northstar.organizationId);
    const owner = contextOf(world.northstar.organizationId, world.northstar.owner, 'owner');
    expect(
      await status(
        service().update(owner, {
          aiEnabled: true,
          blockMembershipIds: [world.twin.owner.membershipId],
        }),
      ),
    ).toBe('404 copilot.settings:member_not_found');
    expect(await rows('select ai_enabled from ai_workspace_settings')).toEqual([{ ai_enabled: 0 }]);
    expect(await rows('select membership_id from ai_member_blocks')).toEqual([]);

    const designer = world.northstar.designer;
    const view = await service().update(owner, { blockMembershipIds: [designer.membershipId] });
    expect(view.blockedMembers.map((m) => m.membershipId)).toEqual([designer.membershipId]);
    const blocked = await rows(
      'select e.object_id from audit_events e where e.organization_id = ? and e.action = ?',
      [world.northstar.organizationId, AI_SETTINGS_MEMBER_BLOCKED_AUDIT_ACTION],
    );
    expect(blocked).toEqual([{ object_id: designer.membershipId }]);
    const asDesigner = contextOf(world.northstar.organizationId, designer, 'member');
    expect(await databaseStanding(database)(asDesigner)).toMatchObject({ memberBlocked: true });

    await service().update(owner, { allowMembershipIds: [designer.membershipId] });
    expect(await rows('select membership_id from ai_member_blocks')).toEqual([]);
    expect(await databaseStanding(database)(asDesigner)).toMatchObject({ memberBlocked: false });
  });
});
