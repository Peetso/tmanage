import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { uuidv7 } from '@tmanage/domain';
import { allows, parseGrantScript } from '../src/common/database/grants.js';
import { TABLES } from '../src/common/database/schema.js';
import { TENANT_TABLES } from '../src/common/database/tenant-guard.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * INT-52-08 — 0288 period locks at the engine. The registry places hold `time_period_locks`; a
 * locked `work_item_time_logs` row refuses a raw UPDATE of a data column and a DELETE on the
 * runtime credential (45000), and the unlock write (`locked_at` back to NULL) goes through.
 */

let db: TestDatabase;
let world: SeedWorld;

const HERE = dirname(fileURLToPath(import.meta.url));
const intents = parseGrantScript(
  readFileSync(resolve(HERE, '../../../scripts/db/users.sql'), 'utf8'),
);

beforeAll(async () => {
  db = await startTestDatabase();
}, 300_000);

beforeEach(async () => {
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
});

afterAll(async () => {
  await db.stop();
});

/** One time entry for the seeded owner, locked when asked. */
async function entry(locked: boolean): Promise<string> {
  const id = uuidv7();
  await db.admin.query(
    `INSERT INTO work_item_time_logs
       (id, organization_id, work_item_id, project_id, logged_by, minutes, spent_on, created_at,
        locked_at)
     VALUES (?, ?, ?, ?, ?, 30, '2026-09-10', ?, ?)`,
    [
      id,
      world.northstar.organizationId,
      world.northstar.workItemId,
      world.northstar.projectId,
      world.northstar.owner.membershipId,
      new Date('2026-09-10T10:00:00Z'),
      locked ? new Date('2026-10-01T00:00:00Z') : null,
    ],
  );
  return id;
}

describe('0288 — registry', () => {
  it('is in TABLES and TENANT_TABLES, and users.sql grants the app no DELETE on it', () => {
    expect(Object.keys(TABLES)).toContain('time_period_locks');
    expect(TENANT_TABLES['time_period_locks']).toBe('organization_id');
    const app = intents.get("'tmanage_app'@'%'") as NonNullable<ReturnType<typeof intents.get>>;
    expect(allows(app, 'tmanage.time_period_locks:UPDATE')).toBe(true);
    expect(allows(app, 'tmanage.time_period_locks:DELETE')).toBe(false);
    expect(allows(app, 'tmanage.work_item_time_logs:UPDATE')).toBe(true);
  });
});

describe('INT-52-08 — a locked entry at the engine', () => {
  it('refuses an UPDATE of a data column with 45000', async () => {
    const id = await entry(true);
    await expect(
      db.runtime.query('UPDATE work_item_time_logs SET minutes = 45 WHERE id = ?', [id]),
    ).rejects.toMatchObject({ sqlState: '45000' });
  });

  it('refuses a DELETE with 45000', async () => {
    const id = await entry(true);
    await expect(
      db.runtime.query('DELETE FROM work_item_time_logs WHERE id = ?', [id]),
    ).rejects.toMatchObject({ sqlState: '45000' });
  });

  it('lets the unlock write through, and then the entry is editable again', async () => {
    const id = await entry(true);
    await db.runtime.query('UPDATE work_item_time_logs SET locked_at = NULL WHERE id = ?', [id]);
    await db.runtime.query('UPDATE work_item_time_logs SET minutes = 45 WHERE id = ?', [id]);
    const [rows] = await db.admin.query(
      'SELECT minutes, locked_at FROM work_item_time_logs WHERE id = ?',
      [id],
    );
    expect(rows).toMatchObject([{ minutes: 45, locked_at: null }]);
  });

  it('lets the lock stamp land on an unlocked entry', async () => {
    const id = await entry(false);
    await db.runtime.query('UPDATE work_item_time_logs SET locked_at = ? WHERE id = ?', [
      new Date('2026-10-01T00:00:00Z'),
      id,
    ]);
    await expect(
      db.runtime.query('DELETE FROM work_item_time_logs WHERE id = ?', [id]),
    ).rejects.toMatchObject({ sqlState: '45000' });
  });
});
