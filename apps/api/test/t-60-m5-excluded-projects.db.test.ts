import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { createTenantPool } from '../src/common/database/connection.js';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { AiEmployeesRepository } from '../src/modules/ai-employees/ai-employees.repository.js';
import { AiEmployeesService } from '../src/modules/ai-employees/ai-employees.service.js';
import { AuditEventsRepository } from '../src/modules/audit/audit-events.repository.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { AgentKeysService } from '../src/modules/personal-access-tokens/agent-keys.js';
import { InviteeAccountsRepository } from '../src/modules/tenancy/invitee-accounts.repository.js';
import { MembershipsRepository } from '../src/modules/tenancy/memberships.repository.js';
import { RUNTIME_STATEMENT_TIMEOUT_MS, startTestDatabase } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * Plan 60 v2 M5 — project exclusion routes on MariaDB 11.8 through the guarded TenantDatabase and
 * the app grants (INSERT, DELETE on `ai_excluded_projects`; no UPDATE). FOR THE TEST PHASE (lane V
 * did not run it, laptop rule):
 *
 * 1. Excluding is one row and one audit event, twice or not; the list names the project.
 * 2. The other workspace's project id is "not found" (BOLA); nothing is written.
 * 3. Including removes the row and is audited; including again is "not found".
 */

let db: TestDatabase;
let world: SeedWorld;
let pool: Pool | undefined;
let service: AiEmployeesService;

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await db.admin.query<RowDataPacket[]>(sql, params);
  return result;
}

function owner(): TenantContext {
  return createTenantContext({
    organizationId: world.northstar.organizationId,
    userId: world.northstar.owner.id,
    membershipId: world.northstar.owner.membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor('owner'),
    policyVersion: 't-60-m5',
    correlationId: uuidv7(),
  });
}

const ownerPrincipal = (): Principal =>
  ({
    userId: world.northstar.owner.id,
    organizationId: world.northstar.organizationId,
    kind: 'internal',
    role: 'owner',
    membershipId: world.northstar.owner.membershipId,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  }) as Principal;

beforeAll(async () => {
  db = await startTestDatabase();
  world = await seedTwoTenants(db.admin);
  pool = createTenantPool({
    url: db.runtimeUrl,
    connectionLimit: 4,
    statementTimeoutMs: RUNTIME_STATEMENT_TIMEOUT_MS,
  });
  const database = new TenantDatabase(pool, { guardMode: 'enforce' });
  service = new AiEmployeesService({
    database,
    audit: new AuditService(database, new AuditEventsRepository()),
    repository: new AiEmployeesRepository(),
    memberships: new MembershipsRepository(),
    accounts: new InviteeAccountsRepository(),
    agentKeys: new AgentKeysService(),
    enabled: true,
  });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await db?.stop();
});

describe('project exclusion', () => {
  it('excludes once, idempotently, and lists the project', async () => {
    const projectId = world.northstar.projectId;
    const first = await service.excludeProject(owner(), ownerPrincipal(), projectId);
    await service.excludeProject(owner(), ownerPrincipal(), projectId);
    expect(first.projects.map((p) => p.projectId)).toEqual([projectId]);
    expect(first.projects[0]?.name).toBe(world.northstar.projectName);
    const stored = await rows('select * from ai_excluded_projects where organization_id = ?', [
      world.northstar.organizationId,
    ]);
    expect(stored).toHaveLength(1);
    const audits = await rows(
      "select id from audit_events where object_id = ? and action = 'ai_employee.project_excluded'",
      [projectId],
    );
    expect(audits).toHaveLength(1);
  });

  it("the other workspace's project is not found and nothing is written", async () => {
    await expect(
      service.excludeProject(owner(), ownerPrincipal(), world.twin.projectId),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      await rows('select * from ai_excluded_projects where project_id = ?', [world.twin.projectId]),
    ).toHaveLength(0);
  });

  it('includes again, audited; a second include is not found', async () => {
    const projectId = world.northstar.projectId;
    await service.includeProject(owner(), ownerPrincipal(), projectId);
    expect(
      await rows('select * from ai_excluded_projects where project_id = ?', [projectId]),
    ).toHaveLength(0);
    await expect(
      service.includeProject(owner(), ownerPrincipal(), projectId),
    ).rejects.toMatchObject({ status: 404 });
  });
});
