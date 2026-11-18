import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFile, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { createMigrationConnection } from '../src/common/database/connection.js';
import { migrate, readLedger } from '../src/common/database/migrator.js';
import { migrationsDirectory, startTestDatabase } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';

/**
 * PLAT-022 — the platform-admin v2 migrations (0239–0248) apply on MariaDB 11.8 on top of a
 * populated database at 0238, the schema the live site runs before this wave ships.
 *
 * The rest of the suite migrates an empty database; this proves the upgrade path the deploy takes:
 * existing organizations, people, memberships and content survive, every new column starts in its
 * neutral state (nothing deleted, nobody disabled), and the ledger records each file once.
 */

const LIVE_HEAD = 238;
const LIVE_ROLE_ID = '0199aa00-0000-7000-8000-00000000c022';
const WAVE = [239, 240, 241, 242, 243, 244, 245, 246, 247, 248];

let db: TestDatabase;
let connection: Connection;

async function count(table: string): Promise<number> {
  const [rows] = await connection.query<RowDataPacket[]>(`select count(*) as n from ${table}`);
  return Number(rows[0]?.['n']);
}

beforeAll(async () => {
  db = await startTestDatabase({ applyMigrations: false, scratch: true });
  connection = await createMigrationConnection(db.url);
}, 240_000);

afterAll(async () => {
  await connection?.end();
  await db?.stop();
});

describe('upgrade from the live schema (0238) with data in it', () => {
  const before: Record<string, number> = {};
  const tables = ['organizations', 'users', 'memberships', 'projects', 'work_items', 'messages'];

  it('builds the live schema at 0238 and fills it', async () => {
    const files = (await readdir(migrationsDirectory)).filter((file) => file.endsWith('.sql'));
    const live = await mkdtemp(join(tmpdir(), 'tmanage-live-0238-'));
    for (const file of files.filter((name) => Number(name.slice(0, 4)) <= LIVE_HEAD)) {
      await copyFile(join(migrationsDirectory, file), join(live, file));
    }
    await migrate(connection, { directory: live, appliedBy: 'plat-022-live' });
    const ledger = await readLedger(connection);
    expect(Math.max(...ledger.map((row) => row.version))).toBe(LIVE_HEAD);

    const world = await seedTwoTenants(db.admin);
    // A custom role saved on the live site before the wave (0071 shape).
    await connection.query(
      `insert into custom_roles (id, organization_id, name, capabilities_json, created_by)
       values (?, ?, 'Delivery lead', ?, ?)`,
      [
        LIVE_ROLE_ID,
        world.northstar.organizationId,
        JSON.stringify(['work.read', 'work.update', 'meeting.write']),
        world.northstar.owner.id,
      ],
    );
    for (const table of tables) before[table] = await count(table);
    expect(before['organizations']).toBeGreaterThan(0);
    expect(before['work_items']).toBeGreaterThan(0);
  });

  it('applies 0239–0247 on MariaDB 11.8 and keeps every row', async () => {
    const [version] = await connection.query<RowDataPacket[]>('select version() as v');
    expect(String(version[0]?.['v'])).toMatch(/^11\.8\..*MariaDB/i);

    const report = await migrate(connection, {
      directory: migrationsDirectory,
      appliedBy: 'plat-022-deploy',
    });
    // The deploy applies the wave and then every later file, in order, up to today's head.
    const later = (await readdir(migrationsDirectory))
      .filter((file) => file.endsWith('.sql'))
      .map((file) => Number(file.slice(0, 4)))
      .filter((version) => version > LIVE_HEAD)
      .sort((a, b) => a - b);
    const applied = report.applied.map((file) => file.version);
    expect(applied.slice(0, WAVE.length)).toEqual(WAVE);
    expect(applied).toEqual(later);
    const ledger = await readLedger(connection);
    for (const wave of WAVE) {
      expect(ledger.filter((row) => row.version === wave && row.status === 'applied')).toHaveLength(
        1,
      );
    }
    for (const table of tables) expect(await count(table), table).toBe(before[table]);
  });

  it('starts every new column in its neutral state', async () => {
    const [orgs] = await connection.query<RowDataPacket[]>(
      'select count(*) as n from organizations where deleted_at is not null or purge_after is not null',
    );
    expect(Number(orgs[0]?.['n'])).toBe(0);
    const [users] = await connection.query<RowDataPacket[]>(
      'select count(*) as n from users where disabled_at is not null or two_step_required_at is not null',
    );
    expect(Number(users[0]?.['n'])).toBe(0);
    const [items] = await connection.query<RowDataPacket[]>(
      'select count(*) as n from work_items where purge_after is not null',
    );
    expect(Number(items[0]?.['n'])).toBe(0);
    for (const table of [
      'platform_admins',
      'platform_support_sessions',
      'membership_permission_overrides',
      'organization_limits',
      'platform_export_jobs',
    ]) {
      expect(await count(table), table).toBe(0);
    }
  });

  it('keeps a stored custom role able to do what it could before (0248 back-fill)', async () => {
    const [role] = await connection.query<RowDataPacket[]>(
      'select capabilities_json as caps from custom_roles where id = ?',
      [LIVE_ROLE_ID],
    );
    const caps = JSON.parse(String(role[0]?.['caps'])) as string[];
    expect([...caps].sort()).toEqual(
      [
        'work.read',
        'work.update',
        'meeting.write',
        'people.view',
        'report.view',
        'ai.use',
        'decision.read',
        'decision.write',
        'work.delete',
      ].sort(),
    );
  });

  it('is a no-op the second time (a redeploy re-runs the migrator)', async () => {
    const again = await migrate(connection, {
      directory: migrationsDirectory,
      appliedBy: 'plat-022-redeploy',
    });
    expect(again.applied).toEqual([]);
  });
});
