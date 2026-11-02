import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, findCycle, uuidv7 } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { ProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { WorkItemsRepository } from '../src/modules/work/work-items.repository.js';
import { WorkGraphRepository } from '../src/modules/work/work-graph.repository.js';
import { WorkItemsService } from '../src/modules/work/work-items.service.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';

/**
 * INT 53-T-09 as a DB case: two concurrent inserts that would together close a loop
 * (a → b and b → a) serialise on the project-row lock, so exactly one lands and the graph
 * holds no cycle. Also: 0293's narrowed trigger lets kind/lag change and still refuses the ends.
 */

let db: TestDatabase;
let ctx: TenantContext;
let owner: Principal;
let work: WorkItemsService;
let projectId: string;

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  const world = await seedTwoTenants(db.admin);
  projectId = world.northstar.projectId;
  const tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
  ctx = createTenantContext({
    organizationId: world.northstar.organizationId,
    userId: world.northstar.owner.id,
    membershipId: world.northstar.owner.membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor('owner'),
    policyVersion: '2026-08-30',
    correlationId: uuidv7(),
  });
  owner = {
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    kind: 'internal',
    role: 'owner',
    membershipId: ctx.membershipId,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
  work = new WorkItemsService(
    tenant,
    new WorkItemsRepository(),
    undefined,
    new ProjectsRepository(),
    undefined,
    new WorkGraphRepository(),
  );
});

afterAll(async () => {
  await db?.stop();
});

describe('53-04 dependency race', () => {
  it('two concurrent inserts closing a loop leave one edge and no cycle', async () => {
    const a = await work.create(ctx, owner, { projectId, title: 'Race A' });
    const b = await work.create(ctx, owner, { projectId, title: 'Race B' });
    const results = await Promise.allSettled([
      work.addDependency(ctx, owner, a.id, b.id),
      work.addDependency(ctx, owner, b.id, a.id),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { status: 409 },
    });

    const [rows] = await db.admin.query<RowDataPacket[]>(
      `select work_item_id, depends_on_work_item_id from work_item_dependencies
        where organization_id = ? and work_item_id in (?, ?)`,
      [ctx.organizationId, a.id, b.id],
    );
    const edges = rows.map((r) => ({
      workItemId: String(r['work_item_id']),
      dependsOnWorkItemId: String(r['depends_on_work_item_id']),
    }));
    expect(edges).toHaveLength(1);
    for (const edge of edges)
      expect(
        findCycle(
          edges.filter((e) => e !== edge),
          edge,
        ),
      ).toBeNull();

    await db.admin.execute(
      `update work_item_dependencies set kind = 'SS', lag_working_days = 2
        where organization_id = ? and work_item_id in (?, ?)`,
      [ctx.organizationId, a.id, b.id],
    );
    await expect(
      db.admin.execute(
        `update work_item_dependencies set depends_on_work_item_id = work_item_id
          where organization_id = ? and work_item_id in (?, ?)`,
        [ctx.organizationId, a.id, b.id],
      ),
    ).rejects.toThrow(/immutable/);
  });
});
