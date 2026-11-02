import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import { ProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { WorkItemsRepository } from '../src/modules/work/work-items.repository.js';
import { WorkItemsService } from '../src/modules/work/work-items.service.js';
import { WorkItemRecurrenceService } from '../src/modules/work/item-recurrence.service.js';
import { WorkItemRecurrenceRepository } from '../src/modules/work/item-recurrence.repository.js';
import { RecurrenceSpawner } from '../src/modules/work/recurrence-spawner.service.js';
import { DEFAULT_RECURRENCE_CALENDAR } from '../src/modules/work/item-recurrence.service.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';

/**
 * INT 53-T-24: the spawner is idempotent across a restart. A rule set on Wednesday 2026-11-04 for
 * "every Sunday" spawns exactly one Sunday task a day ahead; a second spawner instance (a simulated
 * process restart, so its 15-minute gate is fresh) finds the occurrence claimed and creates nothing.
 */

let db: TestDatabase;
let tenant: TenantDatabase;
let work: WorkItemsService;
let seedId: string;
let organizationId: string;

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  const world = await seedTwoTenants(db.admin);
  organizationId = world.northstar.organizationId;
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
  const ctx = createTenantContext({
    organizationId,
    userId: world.northstar.owner.id,
    membershipId: world.northstar.owner.membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor('owner'),
    policyVersion: '2026-08-30',
    correlationId: uuidv7(),
  });
  const owner: Principal = {
    userId: ctx.userId,
    organizationId,
    kind: 'internal',
    role: 'owner',
    membershipId: ctx.membershipId,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
  const repo = new WorkItemsRepository();
  work = new WorkItemsService(tenant, repo, undefined, new ProjectsRepository());
  seedId = (
    await work.create(ctx, owner, { projectId: world.northstar.projectId, title: 'Report' })
  ).id;
  const rules = new WorkItemRecurrenceService(tenant, repo, new WorkItemRecurrenceRepository(), {
    now: () => new Date('2026-11-04T08:00:00Z'),
  });
  await rules.set(ctx, owner, seedId, { rrule: 'FREQ=WEEKLY;BYDAY=SU', holidayPolicy: 'keep' });
});

afterAll(async () => {
  await db?.stop();
});

const spawnerOf = () =>
  new RecurrenceSpawner({
    database: tenant,
    workItems: work,
    workItemsRepository: new WorkItemsRepository(),
    calendars: DEFAULT_RECURRENCE_CALENDAR,
  });

describe('53-09 recurrence spawner', () => {
  it('spawns one Sunday task a day ahead and never duplicates after a restart', async () => {
    expect((await spawnerOf().sweep(new Date('2026-11-07T08:00:00Z'))).spawned).toBe(1);
    const second = await spawnerOf().sweep(new Date('2026-11-07T08:20:00Z'));
    expect(second.spawned).toBe(0);
    const [rows] = await db.admin.query<RowDataPacket[]>(
      `select occurrence_key, work_item_id from work_item_recurrence_instances
        where organization_id = ?`,
      [organizationId],
    );
    expect(rows).toHaveLength(1);
    expect(String(rows[0]?.['occurrence_key'])).toBe('2026-11-08');
    expect(rows[0]?.['work_item_id']).not.toBeNull();
  });
});
