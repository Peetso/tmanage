import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { createTenantPool } from '../src/common/database/connection.js';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { AiEmployeesRepository } from '../src/modules/ai-employees/ai-employees.repository.js';
import { AiEmployeesService } from '../src/modules/ai-employees/ai-employees.service.js';
import type { AiEmployeeView } from '../src/modules/ai-employees/ai-employees.service.js';
import { AuditEventsRepository } from '../src/modules/audit/audit-events.repository.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { AdminOverviewRepository } from '../src/modules/admin/overview.repository.js';
import { BillingSeatsRepository } from '../src/modules/billing/seats.repository.js';
import { SubscriptionRepository } from '../src/modules/billing/subscription.repository.js';
import { InsightsAdoptionRepository } from '../src/modules/insights/adoption.repository.js';
import { WorkloadForecastRepository } from '../src/modules/insights/workload-forecast.repository.js';
import { SignInPolicyRepository } from '../src/modules/identity/sign-in-policy.repository.js';
import { PeopleDirectoryRepository } from '../src/modules/people/directory.repository.js';
import { PeopleOverviewRepository } from '../src/modules/people/people-overview.repository.js';
import { PersonTimeOffRepository } from '../src/modules/people/time-off.repository.js';
import { AgentKeysService } from '../src/modules/personal-access-tokens/agent-keys.js';
import { InviteeAccountsRepository } from '../src/modules/tenancy/invitee-accounts.repository.js';
import { MembershipsRepository } from '../src/modules/tenancy/memberships.repository.js';
import { OrgWorkloadRepository } from '../src/modules/work-views/org-workload.repository.js';
import { RUNTIME_STATEMENT_TIMEOUT_MS, startTestDatabase } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * 60-09 (plan 60 v2 §5, security test 16) on MariaDB 11.8 through the guarded TenantDatabase.
 * FOR THE TEST PHASE (lane V did not run it, laptop rule): hiring an AI employee changes no seat
 * count, headcount, capacity, time-off or directory figure, and its owned work adds no capacity
 * to the forecast. The 422 refusals (capacity, teams, reporting lines) are unit-tested beside
 * their controllers.
 */

let db: TestDatabase;
let world: SeedWorld;
let pool: Pool | undefined;
let database: TenantDatabase;
let mat: AiEmployeeView;
let aiUserId: string;

function owner(): TenantContext {
  return createTenantContext({
    organizationId: world.northstar.organizationId,
    userId: world.northstar.owner.id,
    membershipId: world.northstar.owner.membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor('owner'),
    policyVersion: 't-60-09',
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

let peopleBefore = 0;

beforeAll(async () => {
  db = await startTestDatabase();
  world = await seedTwoTenants(db.admin);
  pool = createTenantPool({
    url: db.runtimeUrl,
    connectionLimit: 4,
    statementTimeoutMs: RUNTIME_STATEMENT_TIMEOUT_MS,
  });
  database = new TenantDatabase(pool, { guardMode: 'enforce' });
  peopleBefore = await database.read(owner(), (r) =>
    new SubscriptionRepository().countInternalPeople(r, owner()),
  );
  const service = new AiEmployeesService({
    database,
    audit: new AuditService(database, new AuditEventsRepository()),
    repository: new AiEmployeesRepository(),
    memberships: new MembershipsRepository(),
    accounts: new InviteeAccountsRepository(),
    agentKeys: new AgentKeysService(),
    enabled: true,
  });
  // 60-07: a hire names the projects he may work in (his boundary).
  mat = await service.hire(owner(), ownerPrincipal(), {
    displayName: 'Mat',
    jobTitle: 'Designer',
    projectIds: [world.northstar.projectId],
  });
  const [found] = await db.admin.query<RowDataPacket[]>(
    'select user_id from memberships where id = ?',
    [mat.membershipId],
  );
  aiUserId = String(found[0]?.['user_id']);
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await db?.stop();
});

describe('60-09 an AI employee is not counted as a person', () => {
  it('billing people count is unchanged', async () => {
    const after = await database.read(owner(), (r) =>
      new SubscriptionRepository().countInternalPeople(r, owner()),
    );
    expect(after).toBe(peopleBefore);
  });

  it('no seat can be assigned to it', async () => {
    const found = await database.read(owner(), (r) =>
      new BillingSeatsRepository().findMembership(r, owner(), mat.membershipId),
    );
    expect(found).toBeNull();
  });

  it('it is absent from the roster, the workload members and the directory', async () => {
    const ids = await database.read(owner(), async (r) => ({
      roster: (await new PeopleOverviewRepository().roster(r, owner())).map((x) => x.membershipId),
      workload: (
        await new OrgWorkloadRepository().listInternalMembers(r, owner(), {
          afterMembershipId: null,
          limit: 500,
        })
      ).map((x) => x.membershipId),
      directory: (await new PeopleDirectoryRepository().list(r, owner(), { limit: 100 })).map(
        (x) => x.membershipId,
      ),
    }));
    expect(ids.roster).not.toContain(mat.membershipId);
    expect(ids.workload).not.toContain(mat.membershipId);
    expect(ids.directory).not.toContain(mat.membershipId);
    expect(ids.roster).toContain(world.northstar.owner.membershipId);
  });

  it('it has no time off, and its owned work adds no forecast capacity', async () => {
    const person = await database.read(owner(), (r) =>
      new PersonTimeOffRepository().resolvePersonMembership(r, owner(), aiUserId),
    );
    expect(person).toBeNull();
    const ai = await database.read(owner(), (r) =>
      new WorkloadForecastRepository().aiUserIds(r, owner()),
    );
    expect(ai.has(aiUserId)).toBe(true);
    expect(ai.has(world.northstar.owner.id)).toBe(false);
  });

  it('it is no seat or active member on the admin overview and in adoption', async () => {
    const reads = await database.read(owner(), async (r) => ({
      seats: (await new AdminOverviewRepository().listSeatMemberships(r, owner())).map(
        (x) => x.membershipId,
      ),
      adoption: (await new InsightsAdoptionRepository().listActiveMembers(r, owner())).map(
        (x) => x.userId,
      ),
    }));
    expect(reads.seats).not.toContain(mat.membershipId);
    expect(reads.seats).toContain(world.northstar.owner.membershipId);
    expect(reads.adoption).not.toContain(aiUserId);
  });

  it('a sign-in policy cannot be held back by an AI employee that never signs in', async () => {
    // Nobody in the seed holds this provider, so every active non-owner person is counted.
    const [people] = await db.admin.query<RowDataPacket[]>(
      `select count(*) as n from memberships where organization_id = ? and status = 'active'
         and role <> 'owner' and kind = 'human' and platform_support_session_id is null`,
      [world.northstar.organizationId],
    );
    const counted = await database.read(owner(), (r) =>
      new SignInPolicyRepository().countMembersWithout(r, owner(), ['t-60-09-none']),
    );
    const [clients] = await db.admin.query<RowDataPacket[]>(
      `select count(*) as n from client_memberships where organization_id = ? and status = 'active'`,
      [world.northstar.organizationId],
    );
    expect(counted).toBe(Number(people[0]?.['n']) + Number(clients[0]?.['n']));
  });
});
