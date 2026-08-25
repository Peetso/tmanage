import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { SqlParameter, TenantContext } from '../src/common/database/tenant-context.js';
import {
  TENANT_TABLES,
  isNonTenantTable,
  isTenantTable,
} from '../src/common/database/tenant-guard.js';
import type { TenantGuardEvent } from '../src/common/database/tenant-guard.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { adjacentUuid, seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * The isolation corpus — `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §11, ADR-0001
 * layer 5.
 *
 * Runs against a real MySQL server (ADR-0002), against two organizations with
 * **intentionally similar names and adjacent identifiers**, because a corpus seeded with
 * obviously distinct tenants passes even when the tenant predicate is missing.
 *
 * Every rejection test also asserts what the rejected statement *would* have done. A test
 * that only checks "the guard threw" would still pass if the guard were rejecting for the
 * wrong reason, or if the schema underneath had quietly stopped containing the data the
 * guard is protecting.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let guardEvents: TenantGuardEvent[];
let northstar: TenantContext;
let twin: TenantContext;

const contextFor = (
  organizationId: string,
  userId: string,
  membershipId: string,
  role: 'owner' | 'client_reviewer',
): TenantContext =>
  createTenantContext({
    organizationId,
    userId,
    membershipId,
    principalKind: role === 'owner' ? 'internal' : 'client',
    capabilities: capabilitiesFor(role),
    policyVersion: '2026-08-16',
    correlationId: uuidv7(),
  });

/** Unscoped observation of what is actually in the database, for side-effect assertions. */
async function observe(
  sql: string,
  params: readonly SqlParameter[] = [],
): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as SqlParameter[]);
  return rows;
}

beforeAll(async () => {
  db = await startTestDatabase();
  // The embedded server is private to this suite and starts empty; the CI database is
  // shared and long-lived. Truncating unconditionally means the corpus asserts against a
  // world it seeded rather than one a previous run left behind.
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  guardEvents = [];
  tenant = new TenantDatabase(db.runtime, {
    guardMode: 'enforce',
    onGuardEvent: (event) => guardEvents.push(event),
  });
  northstar = contextFor(
    world.northstar.organizationId,
    world.northstar.owner.id,
    world.northstar.owner.membershipId,
    'owner',
  );
  twin = contextFor(
    world.twin.organizationId,
    world.twin.owner.id,
    world.twin.owner.membershipId,
    'owner',
  );
});

afterAll(async () => {
  await db?.stop();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the harness itself', () => {
  it('records which engine and which credential produced this run', () => {
    // Not decoration. ADR-0002 records that local is MySQL and deployed is MariaDB, and
    // that CI is the only place the skew is caught — so a result that does not say which
    // engine it came from cannot discharge that. Likewise ADR-0001 layer 2: a corpus green
    // under a root credential proves nothing about the privileges the application holds.
    expect(['mysql', 'mariadb']).toContain(db.engine.name);
    console.warn(
      `[isolation corpus] engine=${db.engine.name} ${db.engine.version} · ` +
        // `external` means only that TMANAGE_TEST_DATABASE_URL was supplied. It does not
        // mean a container: a long-lived embedded server started outside the per-file
        // lifecycle reaches this branch too, and labelling that run "containerised
        // (compose.yaml)" put a claim in the log that the harness had no way to check.
        // The engine and version printed beside it are what actually distinguish CI's
        // MariaDB from a local MySQL.
        `server=${db.external ? 'external (TMANAGE_TEST_DATABASE_URL)' : 'embedded (ADR-0002)'} · ` +
        `runtime credential=${db.leastPrivilege ? 'tmanage_app (least privilege)' : 'admin'}`,
    );

    if (process.env['CI']) {
      // The containerised MariaDB run and the least-privilege credential are the two things
      // PLAT-003 exists to convert from promise into evidence. If either is missing in CI,
      // the corpus is still green while proving less than the status document claims — so
      // it fails here instead, loudly, rather than passing quietly.
      expect(db.external, 'CI must run the containerised stack, not the embedded server').toBe(
        true,
      );
      expect(db.engine.name, 'CI must run MariaDB — that is the skew ADR-0002 defers to it').toBe(
        'mariadb',
      );
      expect(
        db.leastPrivilege,
        'CI must run the corpus as tmanage_app — ADR-0001 layer 2 is unproven otherwise',
      ).toBe(true);
    }
  });

  it('hands out connections with the session state applied', async () => {
    const rows = await tenant.read(northstar, (tx) =>
      tx.query<RowDataPacket[]>(
        'select @@session.sql_mode as m, @@session.time_zone as tz, ? as bound',
        [northstar.organizationId],
      ),
    );
    expect(db.connectionErrors).toEqual([]);
    expect(String(rows[0]?.['m'])).toContain('STRICT_ALL_TABLES');
    expect(String(rows[0]?.['tz'])).toBe('+00:00');
  });

  it('refuses a truncating write, so an over-long id cannot silently become another id', async () => {
    // Without STRICT_ALL_TABLES this stores the first 36 characters — which is a real,
    // different identifier — and reports success.
    await expect(
      tenant.transaction(northstar, (tx) =>
        tx.execute(
          'insert into work_items (id, organization_id, project_id, title) values (?, ?, ?, ?)',
          [
            uuidv7(),
            northstar.organizationId,
            `${world.northstar.projectId}-overflow`,
            'Truncated',
          ],
        ),
      ),
    ).rejects.toThrow(/too long/i);
  });
});

describe('the adversarial pair itself (§11)', () => {
  it('seeds two organizations whose ids differ in one character', () => {
    const a = world.northstar.organizationId;
    const b = world.twin.organizationId;
    expect(b).toBe(adjacentUuid(a));
    expect(b).not.toBe(a);
    expect(a.slice(0, -1)).toBe(b.slice(0, -1));
  });

  it('seeds near-identical names and identical project titles', async () => {
    expect(world.twin.projectName).toBe(world.northstar.projectName);
    expect(world.twin.workItemTitle).toBe(world.northstar.workItemTitle);

    const rows = await observe('select id, name, slug from organizations where id in (?, ?)', [
      world.northstar.organizationId,
      world.twin.organizationId,
    ]);
    const names = rows.map((r) => String(r['name'])).sort();
    // "Northstar Studio" vs "Northstar Studios" — one letter apart, so a name-based lookup
    // that forgets its tenant predicate resolves to the wrong organization.
    expect(names).toEqual(['Northstar Studio', 'Northstar Studios']);
    expect(rows.map((r) => String(r['slug'])).sort()).toEqual([
      'northstar-studio',
      'northstar-studios',
    ]);
  });
});

describe('schema invariants (ADR-0001 layer 1)', () => {
  it('registers every table that carries an organization_id column', async () => {
    const rows = await observe(
      `select table_name as t from information_schema.columns
        where table_schema = database() and column_name = 'organization_id'`,
    );
    const withColumn = rows.map((r) => String(r['t'])).sort();
    const registered = Object.entries(TENANT_TABLES)
      .filter(([, column]) => column === 'organization_id')
      .map(([table]) => table)
      .sort();
    // A module migration that adds a tenant table without registering it would otherwise
    // be invisible to the guard — the exact bug this assertion exists to prevent.
    expect(withColumn).toEqual(registered);
  });

  it('classifies every table in the database as tenant-owned or global', async () => {
    const rows = await observe(
      `select table_name as t from information_schema.tables
        where table_schema = database() and table_type = 'BASE TABLE'`,
    );
    const unclassified = rows
      .map((r) => String(r['t']))
      .filter((table) => !isTenantTable(table) && !isNonTenantTable(table))
      .sort();
    // The previous assertion catches a tenant table that forgot to register. This catches the
    // other direction: a table with no `organization_id` at all, which is invisible to that
    // check and yet is exactly what `TenantDatabase.identityRead()` is allowed to reach. A
    // table must be declared global before the no-tenant-context path can touch it, so an
    // unclassified table is a decision nobody made.
    expect(unclassified).toEqual([]);
  });

  it('gives every tenant-owned parent a (organization_id, id) unique key', async () => {
    for (const table of Object.keys(TENANT_TABLES)) {
      if (table === 'organizations') continue;
      const rows = await observe(
        `select index_name as n from information_schema.statistics
          where table_schema = database() and table_name = ? and non_unique = 0
            and seq_in_index = 1 and column_name = 'organization_id'`,
        [table],
      );
      expect(
        rows.length,
        `${table} has no unique key starting with organization_id`,
      ).toBeGreaterThan(0);
    }
  });

  it('declares every tenant child relationship as a composite foreign key', async () => {
    const rows = await observe(
      `select constraint_name as c, table_name as t, count(*) as cols
         from information_schema.key_column_usage
        where table_schema = database() and referenced_table_name is not null
        group by constraint_name, table_name`,
    );
    const byName = new Map(rows.map((r) => [String(r['c']), Number(r['cols'])]));
    for (const name of [
      'fk_projects_workspace_tenant',
      'fk_project_memberships_project_tenant',
      'fk_client_memberships_client_org_tenant',
      'fk_project_clients_project_tenant',
      'fk_project_clients_client_org_tenant',
      'fk_work_items_project_tenant',
    ]) {
      expect(byName.get(name), `${name} is missing`).toBe(2);
    }
  });

  it('stores DATETIME(3) in UTC and CHAR(36) identifiers', async () => {
    const rows = await observe(
      `select column_type as ct, datetime_precision as dp from information_schema.columns
        where table_schema = database() and table_name = 'work_items'
          and column_name in ('id', 'created_at')
        order by column_name`,
    );
    expect(String(rows[0]?.['ct'])).toBe('datetime(3)');
    expect(String(rows[1]?.['ct'])).toBe('char(36)');
  });

  it('uses InnoDB and utf8mb4 on every table', async () => {
    const rows = await observe(
      `select table_name as t, engine as e, table_collation as c
         from information_schema.tables where table_schema = database()`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(String(row['e']), String(row['t'])).toBe('InnoDB');
      expect(String(row['c']), String(row['t'])).toMatch(/^utf8mb4_/);
    }
  });
});

describe('composite foreign keys refuse cross-tenant edges', () => {
  it('rejects a work item pointing at another tenant’s project', async () => {
    // The ids are individually valid: the work item's organization exists, and the project
    // exists. Only the *pair* is wrong, which is precisely what a globally unique id
    // cannot catch and the composite key can.
    await expect(
      db.admin.execute(
        `insert into work_items (id, organization_id, project_id, title)
         values (?, ?, ?, ?)`,
        [uuidv7(), world.twin.organizationId, world.northstar.projectId, 'Cross-tenant work item'],
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it('rejects a project pointing at another tenant’s workspace', async () => {
    await expect(
      db.admin.execute(
        'insert into projects (id, organization_id, workspace_id, name) values (?, ?, ?, ?)',
        [uuidv7(), world.twin.organizationId, world.northstar.workspaceId, 'Borrowed workspace'],
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it('rejects sharing a project with another tenant’s client organization', async () => {
    await expect(
      db.admin.execute(
        `insert into project_clients (id, organization_id, project_id, client_organization_id)
         values (?, ?, ?, ?)`,
        [
          uuidv7(),
          world.twin.organizationId,
          world.twin.projectId,
          world.atlas.clientOrganizationId,
        ],
      ),
    ).rejects.toThrow(/foreign key/i);
  });
});

describe('organization_id is immutable (ADR-0001 layer 1)', () => {
  it('rejects moving a row between tenants even on the admin connection', async () => {
    // This is the case layers 3 and 4 cannot cover: a direct SQL session with full
    // privileges. The trigger is what still holds.
    await expect(
      db.admin.execute('update work_items set organization_id = ? where id = ?', [
        world.twin.organizationId,
        world.northstar.workItemId,
      ]),
    ).rejects.toThrow(/immutable/i);

    const [row] = await observe('select organization_id as o from work_items where id = ?', [
      world.northstar.workItemId,
    ]);
    expect(String(row?.['o'])).toBe(world.northstar.organizationId);
  });

  it('rejects rewriting the tenant root’s own id', async () => {
    await expect(
      db.admin.execute('update organizations set id = ? where id = ?', [
        uuidv7(),
        world.twin.organizationId,
      ]),
    ).rejects.toThrow(/immutable/i);
  });

  it('still allows an ordinary update that leaves the tenant key alone', async () => {
    const [result] = await db.admin.execute<ResultSetHeader>(
      'update work_items set state = ? where organization_id = ? and id = ?',
      ['review', world.northstar.organizationId, world.northstar.workItemId],
    );
    expect(result.affectedRows).toBe(1);
  });
});

describe('reads', () => {
  it('returns only the acting tenant’s projects', async () => {
    const rows = await tenant.read(northstar, (tx) =>
      tx.execute<RowDataPacket[]>('select id, name from projects where organization_id = ?', [
        northstar.organizationId,
      ]),
    );
    const ids = rows.map((r) => String(r['id']));
    expect(ids).toContain(world.northstar.projectId);
    expect(ids).not.toContain(world.twin.projectId);
    expect(ids).not.toContain(world.brightops.projectId);
  });

  it('refuses the same read without a tenant predicate, and the omission would have leaked', async () => {
    await expect(
      tenant.read(northstar, (tx) => tx.execute('select id, name from projects')),
    ).rejects.toThrow(/no organization_id predicate/);

    // What the guard prevented: three tenants' projects in one result set, including two
    // rows with the identical name.
    const leaked = await observe('select organization_id as o, name as n from projects');
    const tenants = new Set(leaked.map((r) => String(r['o'])));
    expect(tenants.size).toBeGreaterThan(1);
    expect(leaked.filter((r) => String(r['n']) === world.northstar.projectName)).toHaveLength(2);
  });

  it('returns nothing for a direct-id lookup of the twin’s project', async () => {
    // Direct-ID enumeration (§11): the id is real and correct, the tenant is not.
    const rows = await tenant.read(northstar, (tx) =>
      tx.execute<RowDataPacket[]>('select id from projects where organization_id = ? and id = ?', [
        northstar.organizationId,
        world.twin.projectId,
      ]),
    );
    expect(rows).toHaveLength(0);
  });

  it('is not satisfied by the adjacent organization id', async () => {
    const rows = await tenant.read(twin, (tx) =>
      tx.execute<RowDataPacket[]>(
        'select id from work_items where organization_id = ? and id = ?',
        [twin.organizationId, world.northstar.workItemId],
      ),
    );
    expect(rows).toHaveLength(0);
  });

  it('rejects a read whose predicate names another organization', async () => {
    await expect(
      tenant.read(northstar, (tx) =>
        tx.execute('select id from projects where organization_id = ?', [twin.organizationId]),
      ),
    ).rejects.toThrow(/not the active tenant context/);
  });

  it('separates two projects inside one tenant', async () => {
    const rows = await tenant.read(northstar, (tx) =>
      tx.execute<RowDataPacket[]>(
        'select id, title from work_items where organization_id = ? and project_id = ?',
        [northstar.organizationId, world.northstar.otherProjectId],
      ),
    );
    expect(rows).toHaveLength(0);
  });

  it('separates two client organizations inside one tenant', async () => {
    const rows = await tenant.read(northstar, (tx) =>
      tx.execute<RowDataPacket[]>(
        `select pc.project_id as p from project_clients pc
          where pc.organization_id = ? and pc.client_organization_id = ?`,
        [northstar.organizationId, world.meridian.clientOrganizationId],
      ),
    );
    expect(rows.map((r) => String(r['p']))).toEqual([world.meridian.projectId]);
  });

  it('scopes a join on both sides', async () => {
    const rows = await tenant.read(northstar, (tx) =>
      tx.execute<RowDataPacket[]>(
        `select w.title as t from work_items w
           join projects p on p.organization_id = w.organization_id and p.id = w.project_id
          where w.organization_id = ?`,
        [northstar.organizationId],
      ),
    );
    expect(rows.map((r) => String(r['t']))).toEqual([world.northstar.workItemTitle]);
  });

  it('rejects a join that binds only one side to the tenant', async () => {
    await expect(
      tenant.read(northstar, (tx) =>
        tx.execute(
          `select w.title from work_items w join projects p on p.id = w.project_id
            where w.organization_id = ?`,
          [northstar.organizationId],
        ),
      ),
    ).rejects.toThrow(/no organization_id predicate binds projects/);
  });

  it('leaves global identity tables reachable without a tenant predicate', async () => {
    const rows = await tenant.read(northstar, (tx) =>
      tx.execute<RowDataPacket[]>('select id from users where email = ?', [world.twin.owner.email]),
    );
    // Identity is global by design: the same person may hold memberships in many
    // organizations. What must not leak is that person's *tenant data*, tested above.
    expect(rows).toHaveLength(1);
  });
});

describe('writes', () => {
  it('commits a scoped insert and leaves the twin untouched', async () => {
    const id = uuidv7();
    await tenant.transaction(northstar, async (tx) => {
      await tx.execute(
        `insert into work_items (id, organization_id, project_id, title)
         values (?, ?, ?, ?)`,
        [id, northstar.organizationId, world.northstar.projectId, 'Draft Arabic booking FAQ'],
      );
    });

    const rows = await observe('select organization_id as o from work_items where id = ?', [id]);
    expect(String(rows[0]?.['o'])).toBe(world.northstar.organizationId);

    const twinRows = await observe(
      'select id from work_items where organization_id = ? and title = ?',
      [world.twin.organizationId, 'Draft Arabic booking FAQ'],
    );
    expect(twinRows).toHaveLength(0);
  });

  it('refuses an insert that takes the organization from the payload rather than the context', async () => {
    const id = uuidv7();
    await expect(
      tenant.transaction(northstar, (tx) =>
        tx.execute(
          `insert into work_items (id, organization_id, project_id, title)
           values (?, ?, ?, ?)`,
          // The shape of the real bug: a DTO carried organization_id and a repository
          // passed it through instead of deriving it from TenantContext.
          [id, twin.organizationId, world.twin.projectId, 'Injected work item'],
        ),
      ),
    ).rejects.toThrow(/writes an organization other than the active tenant context/);

    expect(await observe('select id from work_items where id = ?', [id])).toHaveLength(0);
  });

  it('refuses an insert that omits the tenant key', async () => {
    await expect(
      tenant.transaction(northstar, (tx) =>
        tx.execute('insert into work_items (id, project_id, title) values (?, ?, ?)', [
          uuidv7(),
          world.northstar.projectId,
          'No tenant key',
        ]),
      ),
    ).rejects.toThrow(/omits organization_id/);
  });

  it('rolls the whole unit of work back when any statement fails', async () => {
    const id = uuidv7();
    await expect(
      tenant.transaction(northstar, async (tx) => {
        await tx.execute(
          'insert into work_items (id, organization_id, project_id, title) values (?, ?, ?, ?)',
          [id, northstar.organizationId, world.northstar.projectId, 'Half-written'],
        );
        // Spec §3 step 8 puts the audit event in the same transaction as the change; a
        // partial commit would produce a change with no audit trail.
        await tx.execute('select id from projects');
      }),
    ).rejects.toThrow();

    expect(await observe('select id from work_items where id = ?', [id])).toHaveLength(0);
  });
});

describe('bulk changes', () => {
  it('refuses an unscoped bulk update, and the omission would have hit both tenants', async () => {
    await expect(
      tenant.transaction(northstar, (tx) =>
        tx.execute('update work_items set state = ?', ['cancelled']),
      ),
    ).rejects.toThrow(/no organization_id predicate/);

    const states = await observe('select distinct state as s from work_items');
    expect(states.map((r) => String(r['s']))).not.toContain('cancelled');
  });

  it('confines a scoped bulk update to the acting tenant', async () => {
    await tenant.transaction(northstar, (tx) =>
      tx.execute('update work_items set state = ? where organization_id = ?', [
        'blocked',
        northstar.organizationId,
      ]),
    );

    const twinStates = await observe(
      'select state as s from work_items where organization_id = ?',
      [world.twin.organizationId],
    );
    for (const row of twinStates) expect(String(row['s'])).not.toBe('blocked');

    const brightopsStates = await observe(
      'select state as s from work_items where organization_id = ?',
      [world.brightops.organizationId],
    );
    for (const row of brightopsStates) expect(String(row['s'])).not.toBe('blocked');
  });

  it('refuses an unscoped delete', async () => {
    await expect(
      tenant.transaction(northstar, (tx) => tx.execute('delete from work_items')),
    ).rejects.toThrow(/no organization_id predicate/);
    expect((await observe('select id from work_items')).length).toBeGreaterThan(0);
  });

  it('refuses an update that would move rows between tenants', async () => {
    await expect(
      tenant.transaction(northstar, (tx) =>
        tx.execute('update work_items set organization_id = ? where organization_id = ?', [
          twin.organizationId,
          northstar.organizationId,
        ]),
      ),
    ).rejects.toThrow(/immutable/i);
  });
});

describe('membership state', () => {
  it('stops matching an active-membership lookup once the membership is suspended', async () => {
    const activeQuery = `select id from memberships
                          where organization_id = ? and user_id = ? and status = 'active'`;

    expect(
      await tenant.read(northstar, (tx) =>
        tx.execute<RowDataPacket[]>(activeQuery, [
          northstar.organizationId,
          world.northstar.designer.id,
        ]),
      ),
    ).toHaveLength(1);

    await db.admin.execute('update memberships set status = ? where id = ?', [
      'suspended',
      world.northstar.designer.membershipId,
    ]);

    expect(
      await tenant.read(northstar, (tx) =>
        tx.execute<RowDataPacket[]>(activeQuery, [
          northstar.organizationId,
          world.northstar.designer.id,
        ]),
      ),
    ).toHaveLength(0);

    await db.admin.execute('update memberships set status = ? where id = ?', [
      'active',
      world.northstar.designer.membershipId,
    ]);
  });

  it('stops matching an unexpired client-membership lookup once the membership expires', async () => {
    const unexpired = `select id from client_memberships
                        where organization_id = ? and user_id = ?
                          and (expires_at is null or expires_at > now(3))`;

    expect(
      await tenant.read(northstar, (tx) =>
        tx.execute<RowDataPacket[]>(unexpired, [northstar.organizationId, world.atlas.reviewer.id]),
      ),
    ).toHaveLength(1);

    await db.admin.execute(
      'update client_memberships set expires_at = date_sub(now(3), interval 1 day) where id = ?',
      [world.atlas.reviewer.membershipId],
    );

    expect(
      await tenant.read(northstar, (tx) =>
        tx.execute<RowDataPacket[]>(unexpired, [northstar.organizationId, world.atlas.reviewer.id]),
      ),
    ).toHaveLength(0);

    await db.admin.execute('update client_memberships set expires_at = null where id = ?', [
      world.atlas.reviewer.membershipId,
    ]);
  });
});

describe('platform primitives', () => {
  it('keeps idempotency keys distinct per tenant and unique within one', async () => {
    const key = 'submit-client-request-2026-08-16';
    const insert = (context: TenantContext, actorId: string) =>
      tenant.transaction(context, (tx) =>
        tx.execute(
          `insert into idempotency_records
             (id, organization_id, actor_user_id, operation, \`key\`, request_hash, expires_at)
           values (?, ?, ?, ?, ?, ?, date_add(now(3), interval 1 day))`,
          [uuidv7(), context.organizationId, actorId, 'client_request.submit', key, 'a'.repeat(64)],
        ),
      );

    await insert(northstar, world.northstar.owner.id);
    // The same key in the twin tenant must not collide: one tenant's retry key must not be
    // able to block — or reveal the existence of — another tenant's operation.
    await insert(twin, world.twin.owner.id);

    await expect(insert(northstar, world.northstar.owner.id)).rejects.toThrow(/duplicate/i);
  });

  it('lets the outbox relay read across tenants only through the audited escape hatch', async () => {
    await tenant.transaction(northstar, (tx) =>
      tx.execute(
        `insert into outbox_events
           (id, organization_id, type, aggregate_type, aggregate_id, payload_json)
         values (?, ?, ?, ?, ?, ?)`,
        [
          uuidv7(),
          northstar.organizationId,
          'work_item.created.v1',
          'work_item',
          world.northstar.workItemId,
          JSON.stringify({ workItemId: world.northstar.workItemId }),
        ],
      ),
    );

    const claim =
      'select id, organization_id from outbox_events where published_at is null limit 50';

    await expect(tenant.read(northstar, (tx) => tx.execute(claim))).rejects.toThrow(
      /no organization_id predicate/,
    );

    const before = guardEvents.length;
    const rows = await tenant.read(northstar, (tx) =>
      tx
        .unscoped('outbox relay claims unpublished events across all organizations (PLAT-004)')
        .execute<RowDataPacket[]>(claim),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(guardEvents.slice(before).at(-1)?.allowedReason).toMatch(/outbox relay/);
  });

  it('refuses to update or delete an audit event', async () => {
    const id = uuidv7();
    await tenant.transaction(northstar, (tx) =>
      tx.execute(
        `insert into audit_events
           (id, organization_id, actor_user_id, action, object_type, object_id, result,
            correlation_id, metadata_json)
         values (?, ?, ?, ?, ?, ?, 'allowed', ?, ?)`,
        [
          id,
          northstar.organizationId,
          world.northstar.owner.id,
          'work_item.transition',
          'work_item',
          world.northstar.workItemId,
          northstar.correlationId,
          JSON.stringify({ from: 'triage', to: 'in_progress' }),
        ],
      ),
    );

    // Attempted on the admin connection: append-only must hold for any credential, not
    // only for statements the application layer happens to route through the guard.
    await expect(
      db.admin.execute('update audit_events set result = ? where id = ?', ['denied', id]),
    ).rejects.toThrow(/append-only/i);
    await expect(db.admin.execute('delete from audit_events where id = ?', [id])).rejects.toThrow(
      /append-only/i,
    );

    expect(await observe('select id from audit_events where id = ?', [id])).toHaveLength(1);
  });
});

describe('guard reporting', () => {
  it('emits a security event carrying no tenant data', async () => {
    const before = guardEvents.length;
    await expect(
      tenant.read(northstar, (tx) =>
        tx.execute('select id from projects where name = ?', [world.twin.projectName]),
      ),
    ).rejects.toThrow();

    const event = guardEvents.at(-1);
    expect(guardEvents.length).toBe(before + 1);
    expect(event?.tenantTables).toEqual(['projects']);
    expect(event?.mode).toBe('enforce');
    expect(event?.shape).not.toContain(world.twin.projectName);
    expect(event?.correlationId).toBe(northstar.correlationId);
  });

  it('observe mode lets the leak through, which is why production does not default to it', async () => {
    const observing = new TenantDatabase(db.runtime, { guardMode: 'observe' });
    const rows = await observing.read(northstar, (tx) =>
      tx.execute<RowDataPacket[]>('select organization_id as o from projects'),
    );
    const tenants = new Set(rows.map((r) => String(r['o'])));
    // Three organizations' rows returned to a context bound to one. ADR-0001 layer 3
    // records this as the reason `observe` is reserved for a documented incident.
    expect(tenants.size).toBeGreaterThan(1);
    expect(tenants.has(world.twin.organizationId)).toBe(true);
  });
});

describe('TenantContext', () => {
  it('is frozen, including its capability list', () => {
    expect(Object.isFrozen(northstar)).toBe(true);
    expect(Object.isFrozen(northstar.capabilities)).toBe(true);
    expect(() => {
      (northstar as { organizationId: string }).organizationId = twin.organizationId;
    }).toThrow(TypeError);
    expect(northstar.organizationId).toBe(world.northstar.organizationId);
  });

  it('refuses a non-canonical identifier', () => {
    expect(() =>
      createTenantContext({
        organizationId: world.northstar.organizationId.toUpperCase(),
        userId: world.northstar.owner.id,
        membershipId: world.northstar.owner.membershipId,
        principalKind: 'internal',
        capabilities: [],
        policyVersion: '2026-08-16',
        correlationId: uuidv7(),
      }),
    ).toThrow(/canonical lowercase/);
  });

  it('refuses a malformed identifier', () => {
    expect(() =>
      createTenantContext({
        organizationId: "' or 1=1 --",
        userId: world.northstar.owner.id,
        membershipId: world.northstar.owner.membershipId,
        principalKind: 'internal',
        capabilities: [],
        policyVersion: '2026-08-16',
        correlationId: uuidv7(),
      }),
    ).toThrow(/not a UUID/);
  });
});
