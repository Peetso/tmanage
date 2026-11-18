import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { uuidv7 } from '@tmanage/domain';
import { allows, parseGrantScript } from '../src/common/database/grants.js';
import { TABLES } from '../src/common/database/schema.js';
import { TENANT_TABLES } from '../src/common/database/tenant-guard.js';
import {
  startTestDatabase,
  truncateAll,
  usingLeastPrivilegeCredential,
} from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * 52-02 — 0290 `timesheets` at the engine: the four registry places, one row per member and week,
 * the immutable tenant / owner / week, and no DELETE for the runtime credential.
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

/** One open week of the seeded Northstar owner, inserted on the runtime credential. */
async function sheet(periodStart = '2026-10-25', periodEnd = '2026-10-31'): Promise<string> {
  const id = uuidv7();
  const at = new Date('2026-10-26T09:00:00Z');
  await db.runtime.query(
    `INSERT INTO timesheets
       (id, organization_id, membership_id, period_start, period_end, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      world.northstar.organizationId,
      world.northstar.owner.membershipId,
      periodStart,
      periodEnd,
      at,
      at,
    ],
  );
  return id;
}

describe('0290 — registry', () => {
  it('is in TABLES and TENANT_TABLES, and users.sql grants the app no DELETE on it', () => {
    expect(Object.keys(TABLES)).toContain('timesheets');
    expect(TENANT_TABLES['timesheets']).toBe('organization_id');
    const app = intents.get("'tmanage_app'@'%'") as NonNullable<ReturnType<typeof intents.get>>;
    expect(allows(app, 'tmanage.timesheets:INSERT')).toBe(true);
    expect(allows(app, 'tmanage.timesheets:UPDATE')).toBe(true);
    expect(allows(app, 'tmanage.timesheets:DELETE')).toBe(false);
  });
});

describe('0290 — timesheets at the engine', () => {
  it('holds one row per member and week (the lazy insert races on this key)', async () => {
    await sheet();
    await expect(sheet()).rejects.toMatchObject({ errno: 1062 });
  });

  it('refuses moving the owner or the week with 45000, and lets the state move', async () => {
    const id = await sheet();
    await expect(
      db.runtime.query("UPDATE timesheets SET period_start = '2026-11-01' WHERE id = ?", [id]),
    ).rejects.toMatchObject({ sqlState: '45000' });
    await expect(
      db.runtime.query('UPDATE timesheets SET membership_id = ? WHERE id = ?', [
        world.northstar.manager.membershipId,
        id,
      ]),
    ).rejects.toMatchObject({ sqlState: '45000' });
    await db.runtime.query(
      "UPDATE timesheets SET state = 'submitted', version = version + 1 WHERE id = ?",
      [id],
    );
    const [rows] = await db.admin.query('SELECT state, version FROM timesheets WHERE id = ?', [id]);
    expect(rows).toMatchObject([{ state: 'submitted', version: 2 }]);
  });

  // A grant, not a trigger: only a least-privilege runtime (TMANAGE_TEST_APP_DATABASE_URL) can
  // show it. Locally the suite's runtime is the admin, which may delete anything.
  it.skipIf(!usingLeastPrivilegeCredential)(
    'never lets the runtime credential delete a week',
    async () => {
      const id = await sheet();
      await expect(db.runtime.query('DELETE FROM timesheets WHERE id = ?', [id])).rejects.toThrow();
    },
  );
});
