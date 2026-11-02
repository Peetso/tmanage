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
 * INT-52-16 — 0292 expenses at the engine. The registry places hold `expenses`; a locked row
 * refuses a raw UPDATE of a data column and a DELETE on the runtime credential (45000).
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

/** One expense of the seeded owner, locked when asked (dated from a bound Date). */
async function expense(locked: boolean): Promise<string> {
  const id = uuidv7();
  const at = new Date('2026-10-01T10:00:00Z');
  await db.admin.query(
    `INSERT INTO expenses
       (id, organization_id, project_id, membership_id, spent_on, category, amount_minor, currency,
        state, locked_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, '2026-10-01', 'Ads', 5000, 'SAR', 'approved', ?, ?, ?)`,
    [
      id,
      world.northstar.organizationId,
      world.northstar.projectId,
      world.northstar.owner.membershipId,
      locked ? new Date('2026-10-31T00:00:00Z') : null,
      at,
      at,
    ],
  );
  return id;
}

describe('0292 — registry', () => {
  it('is in TABLES and TENANT_TABLES, and users.sql grants the app its four statements', () => {
    expect(Object.keys(TABLES)).toContain('expenses');
    expect(TENANT_TABLES['expenses']).toBe('organization_id');
    const app = intents.get("'tmanage_app'@'%'") as NonNullable<ReturnType<typeof intents.get>>;
    expect(allows(app, 'tmanage.expenses:DELETE')).toBe(true);
    const worker = intents.get("'tmanage_worker'@'%'") as NonNullable<
      ReturnType<typeof intents.get>
    >;
    expect(allows(worker, 'tmanage.expenses:SELECT')).toBe(false);
  });
});

describe('INT-52-16 — a locked expense at the engine', () => {
  it('refuses an UPDATE of the amount with 45000', async () => {
    const id = await expense(true);
    await expect(
      db.runtime.query('UPDATE expenses SET amount_minor = 9000 WHERE id = ?', [id]),
    ).rejects.toMatchObject({ sqlState: '45000' });
  });

  it('refuses a DELETE with 45000', async () => {
    const id = await expense(true);
    await expect(db.runtime.query('DELETE FROM expenses WHERE id = ?', [id])).rejects.toMatchObject(
      { sqlState: '45000' },
    );
  });

  it('lets an unlocked row change', async () => {
    const id = await expense(false);
    await db.runtime.query('UPDATE expenses SET amount_minor = 9000 WHERE id = ?', [id]);
    const [rows] = await db.admin.query('SELECT amount_minor FROM expenses WHERE id = ?', [id]);
    expect(rows).toMatchObject([{ amount_minor: 9000 }]);
  });
});
