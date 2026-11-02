import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { allows, parseGrantScript } from '../src/common/database/grants.js';
import { TABLES } from '../src/common/database/schema.js';
import { TENANT_TABLES } from '../src/common/database/tenant-guard.js';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import { ProjectBaselineService } from '../src/modules/projects/baseline.service.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * 53-05 (0298) at the engine. Registry: `project_baseline_items` in the four places. INT 53-T-12 /
 * acceptance (b): a fault injected on the 3rd item insert leaves no baseline row at all. The 0298
 * trigger refuses an UPDATE of `label` on the runtime credential (45000) but lets `is_current` move.
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
  await db.admin.query('DROP TRIGGER IF EXISTS trg_test_fault_third_item');
  await db.stop();
});

async function item(title: string): Promise<string> {
  const id = uuidv7();
  const ns = world.northstar;
  await db.admin.query(
    `INSERT INTO work_items (id, organization_id, project_id, title, state) VALUES (?, ?, ?, ?, 'in_progress')`,
    [id, ns.organizationId, ns.projectId, title],
  );
  return id;
}

describe('0298 — registry', () => {
  it('registers project_baseline_items and grants the app no UPDATE on it', () => {
    expect(Object.keys(TABLES)).toContain('project_baseline_items');
    expect(TENANT_TABLES['project_baseline_items']).toBe('organization_id');
    const app = intents.get("'tmanage_app'@'%'") as NonNullable<ReturnType<typeof intents.get>>;
    expect(allows(app, 'tmanage.project_baseline_items:INSERT')).toBe(true);
    expect(allows(app, 'tmanage.project_baseline_items:UPDATE')).toBe(false);
    expect(allows(app, 'tmanage.project_baselines:UPDATE')).toBe(true);
  });
});

describe('INT 53-T-12 — the snapshot is atomic', () => {
  it('leaves no baseline when the 3rd item insert fails', async () => {
    const ns = world.northstar;
    await item('Second');
    const third = await item('Third');
    await db.admin.query('DROP TRIGGER IF EXISTS trg_test_fault_third_item');
    await db.admin.query(
      `CREATE TRIGGER trg_test_fault_third_item BEFORE INSERT ON project_baseline_items
       FOR EACH ROW BEGIN
         IF NEW.work_item_id = '${third}' THEN
           SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected fault';
         END IF;
       END`,
    );
    const context = createTenantContext({
      organizationId: ns.organizationId,
      userId: ns.owner.id,
      membershipId: ns.owner.membershipId,
      principalKind: 'internal',
      capabilities: capabilitiesFor('owner'),
      policyVersion: '2026-08-30',
      correlationId: uuidv7(),
    });
    const owner: Principal = {
      userId: ns.owner.id,
      organizationId: ns.organizationId,
      kind: 'internal',
      role: 'owner',
      membershipId: ns.owner.membershipId,
      membershipStatus: 'active',
      clientOrganizationId: null,
      projectIds: [],
      hasOrgWideScope: true,
    };
    const service = new ProjectBaselineService(
      new TenantDatabase(db.runtime, { guardMode: 'enforce' }),
    );
    try {
      await expect(
        service.snapshot(context, owner, { projectId: ns.projectId, label: 'Kickoff' }),
      ).rejects.toBeTruthy();
    } finally {
      await db.admin.query('DROP TRIGGER IF EXISTS trg_test_fault_third_item');
    }
    const [rows] = await db.admin.query(
      'SELECT COUNT(*) AS n FROM project_baselines WHERE organization_id = ?',
      [ns.organizationId],
    );
    expect(rows).toMatchObject([{ n: 0 }]);
  });
});

describe('0298 — only is_current may change', () => {
  it('refuses an UPDATE of label with 45000 and allows is_current', async () => {
    const ns = world.northstar;
    const id = uuidv7();
    await db.admin.query(
      `INSERT INTO project_baselines (id, organization_id, project_id, label, snapshot, created_by)
       VALUES (?, ?, ?, 'Kickoff', '[]', ?)`,
      [id, ns.organizationId, ns.projectId, ns.owner.id],
    );
    await expect(
      db.runtime.query(`UPDATE project_baselines SET label = 'Rewritten' WHERE id = ?`, [id]),
    ).rejects.toMatchObject({ sqlState: '45000' });
    await db.runtime.query('UPDATE project_baselines SET is_current = 1 WHERE id = ?', [id]);
  });
});
