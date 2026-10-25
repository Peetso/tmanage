import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { parseGrantScript } from '../src/common/database/grants.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * Wave 4 — the column-only migrations of 2026-10-23 (0219, 0220's index, 0222–0226) on the real
 * migrated MariaDB.
 *
 * None of these adds a table, so there is no new tenant key, TENANT_TABLES entry or grant line:
 * each column lands on a table that is already tenant-scoped and already granted. What this suite
 * pins is that every migration left the shape it says it does (nullability, default, enum values,
 * keys) and that the runtime credential already holds the privilege the new write path needs.
 * `schema.db.test.ts` proves Drizzle agrees column by column; this proves the migration's intent.
 */

let db: TestDatabase;
let world: SeedWorld;

const HERE = dirname(fileURLToPath(import.meta.url));
const intents = parseGrantScript(
  readFileSync(resolve(HERE, '../../../scripts/db/users.sql'), 'utf8'),
);
const appPrivileges = (): ReadonlySet<string> =>
  intents.get(`'tmanage_app'@'%'`)?.privileges ?? new Set<string>();

interface Column {
  nullable: boolean;
  type: string;
  defaultValue: string | null;
}

async function column(table: string, name: string): Promise<Column | undefined> {
  const [rows] = await db.admin.query<RowDataPacket[]>(
    `select is_nullable, column_type, column_default from information_schema.columns
      where table_schema = database() and table_name = ? and column_name = ?`,
    [table, name],
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  const raw = row['column_default'] ?? row['COLUMN_DEFAULT'];
  return {
    nullable: String(row['is_nullable'] ?? row['IS_NULLABLE']) === 'YES',
    type: String(row['column_type'] ?? row['COLUMN_TYPE']).toLowerCase(),
    // MariaDB reports a NULL default as the string 'NULL'.
    defaultValue: raw === null || raw === undefined || raw === 'NULL' ? null : String(raw),
  };
}

async function indexColumns(
  table: string,
  index: string,
): Promise<{ unique: boolean; columns: string[] }> {
  const [rows] = await db.admin.query<RowDataPacket[]>(
    `select column_name as c, non_unique as n from information_schema.statistics
      where table_schema = database() and table_name = ? and index_name = ?
      order by seq_in_index`,
    [table, index],
  );
  return {
    unique: rows.length > 0 && Number(rows[0]!['n']) === 0,
    columns: rows.map((row) => String(row['c'])),
  };
}

beforeAll(async () => {
  db = await startTestDatabase();
}, 300_000);

beforeEach(async () => {
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
});

afterAll(async () => {
  await db?.stop();
});

describe('0219 — work_items.description', () => {
  it('is a nullable TEXT, NULL on every existing item, and holds long prose', async () => {
    expect(await column('work_items', 'description')).toEqual({
      nullable: true,
      type: 'text',
      defaultValue: null,
    });
    const [before] = await db.admin.query<RowDataPacket[]>(
      'select description from work_items where id = ?',
      [world.northstar.workItemId],
    );
    expect(before[0]!['description']).toBeNull();

    const prose = 'Scope: '.concat('x'.repeat(4_000));
    await db.admin.execute('update work_items set description = ? where id = ?', [
      prose,
      world.northstar.workItemId,
    ]);
    const [after] = await db.admin.query<RowDataPacket[]>(
      'select description from work_items where id = ?',
      [world.northstar.workItemId],
    );
    expect(after[0]!['description']).toBe(prose);
    expect(appPrivileges().has('tmanage.work_items:UPDATE')).toBe(true);
  });
});

describe('0220 — the defer sweep index', () => {
  it('leads with state so the cross-tenant sweep is one range scan', async () => {
    expect(await indexColumns('client_requests', 'ix_client_requests_state_defer_until')).toEqual({
      unique: false,
      columns: ['state', 'defer_until'],
    });
    expect(await column('client_requests', 'reopen_reminder')).toMatchObject({
      nullable: false,
      defaultValue: '0',
    });
  });
});

describe('0222 — milestone details and the template plan', () => {
  it('adds nullable description/owner to milestones, the owner bound to users', async () => {
    expect(await column('project_milestones', 'description')).toMatchObject({
      nullable: true,
      type: 'text',
    });
    expect(await column('project_milestones', 'owner_user_id')).toMatchObject({
      nullable: true,
      type: 'char(36)',
    });
    const [fk] = await db.admin.query<RowDataPacket[]>(
      `select referenced_table_name as t, referenced_column_name as c
         from information_schema.key_column_usage
        where table_schema = database() and table_name = 'project_milestones'
          and constraint_name = 'fk_project_milestones_owner'`,
    );
    expect(fk.map((row) => [row['t'], row['c']])).toEqual([['users', 'id']]);
    expect(appPrivileges().has('tmanage.project_milestones:UPDATE')).toBe(true);
  });

  it('adds the plan to project_templates: two nullable JSON arrays, a flag off by default, monthly', async () => {
    expect((await column('project_templates', 'milestones_json'))?.nullable).toBe(true);
    expect((await column('project_templates', 'work_items_json'))?.nullable).toBe(true);
    expect(await column('project_templates', 'client_portal_on')).toMatchObject({
      nullable: false,
      type: 'tinyint(1)',
      defaultValue: '0',
    });
    expect(await column('project_templates', 'repeat_interval')).toMatchObject({
      nullable: true,
      type: "enum('monthly')",
    });
  });
});

describe('0223 — project_updates.milestone_id', () => {
  it('is nullable, carries no foreign key, and is indexed inside the tenant', async () => {
    expect(await column('project_updates', 'milestone_id')).toMatchObject({
      nullable: true,
      type: 'char(36)',
    });
    expect(await indexColumns('project_updates', 'ix_project_updates_org_milestone')).toEqual({
      unique: false,
      columns: ['organization_id', 'milestone_id'],
    });
    const [fks] = await db.admin.query<RowDataPacket[]>(
      `select constraint_name from information_schema.key_column_usage
        where table_schema = database() and table_name = 'project_updates'
          and column_name = 'milestone_id' and referenced_table_name is not null`,
    );
    expect(fks).toHaveLength(0);
  });
});

describe('0224 — the organization logo', () => {
  it('adds a nullable logo id and appends org_logo to both purpose enums', async () => {
    expect(await column('organizations', 'logo_file_id')).toMatchObject({
      nullable: true,
      type: 'char(36)',
    });
    // 0224 appends org_logo after document; 0232 (G1) later appends request_message after it,
    // so the fully migrated enum ends with both, in that order.
    const expected =
      "enum('message_attachment','request_attachment','deliverable','document','org_logo','request_message')";
    expect((await column('file_assets', 'purpose'))?.type).toBe(expected);
    expect((await column('upload_sessions', 'purpose'))?.type).toBe(expected);

    const [rows] = await db.admin.query<RowDataPacket[]>(
      'select logo_file_id from organizations where id = ?',
      [world.northstar.organizationId],
    );
    expect(rows[0]!['logo_file_id']).toBeNull();
    expect(appPrivileges().has('tmanage.organizations:UPDATE')).toBe(true);
  });
});

describe('0225 — decision detail', () => {
  it('adds number/rationale/source/audience with a per-tenant unique number', async () => {
    expect(await column('decisions', 'number')).toMatchObject({
      nullable: true,
      type: 'int(10) unsigned',
    });
    expect(await column('decisions', 'rationale')).toMatchObject({ nullable: true, type: 'text' });
    expect(await column('decisions', 'source_message_id')).toMatchObject({
      nullable: true,
      type: 'char(36)',
    });
    const audience = await column('decisions', 'audience');
    expect(audience).toMatchObject({ nullable: false, type: "enum('internal','client_visible')" });
    expect(audience?.defaultValue?.replace(/'/g, '')).toBe('internal');
    // Numbered per organization: the key starts with the tenant, so two studios both have DEC-001.
    expect(await indexColumns('decisions', 'uq_decisions_org_number')).toEqual({
      unique: true,
      columns: ['organization_id', 'number'],
    });
    expect(appPrivileges().has('tmanage.decisions:UPDATE')).toBe(true);
  });
});

describe('0226 — workflow_templates.deleted_at', () => {
  it('is a nullable DATETIME(3) and the runtime may stamp it', async () => {
    expect(await column('workflow_templates', 'deleted_at')).toEqual({
      nullable: true,
      type: 'datetime(3)',
      defaultValue: null,
    });
    expect(appPrivileges().has('tmanage.workflow_templates:UPDATE')).toBe(true);
  });
});
