import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { AI_EMPLOYEE_EMAIL_DOMAIN, capabilitiesFor, uuidv7 } from '@tmanage/domain';
import type { Principal, Role } from '@tmanage/domain';
import { createTenantPool } from '../src/common/database/connection.js';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { AuditEventsRepository } from '../src/modules/audit/audit-events.repository.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { AiEmployeesRepository } from '../src/modules/ai-employees/ai-employees.repository.js';
import {
  AI_EMPLOYEE_AUDIT,
  AiEmployeesService,
} from '../src/modules/ai-employees/ai-employees.service.js';
import { AgentKeysService } from '../src/modules/personal-access-tokens/agent-keys.js';
import { InviteeAccountsRepository } from '../src/modules/tenancy/invitee-accounts.repository.js';
import { MemberBulkRoleRepository } from '../src/modules/tenancy/member-bulk-role.repository.js';
import { MembershipsRepository } from '../src/modules/tenancy/memberships.repository.js';
import { RUNTIME_STATEMENT_TIMEOUT_MS, startTestDatabase } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld, SeededUser } from './seed-two-tenants.js';

/**
 * 60-03 (plan 60 v2 §2.1, §4.1, §5) on MariaDB 11.8 through the guarded TenantDatabase
 * (`guardMode: 'enforce'`) and the app grants. FOR THE TEST PHASE (lane V did not run it, laptop
 * rule):
 *
 * 1. A hire writes one credential-less user on `ai-employee.invalid`, one membership of kind `ai`
 *    and the companion row in one transaction, with one audit row; the joins pass the tenant guard.
 * 2. Another workspace's AI employee is 404 for read and for every change (BOLA, HT-1).
 * 3. Two racing hires past the cap: the organization row lock lets exactly one through.
 * 4. Retire offboards the membership in the same transaction.
 */

let db: TestDatabase;
let world: SeedWorld;
let pool: Pool | undefined;
let service: AiEmployeesService;
let database: TenantDatabase;

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await db.admin.query<RowDataPacket[]>(sql, params);
  return result;
}

function contextOf(organizationId: string, user: SeededUser, role: Role): TenantContext {
  return createTenantContext({
    organizationId,
    userId: user.id,
    membershipId: user.membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor(role),
    policyVersion: 't-60-03',
    correlationId: uuidv7(),
  });
}

function principalOf(organizationId: string, user: SeededUser, role: Role): Principal {
  return {
    userId: user.id,
    organizationId,
    kind: 'internal',
    role,
    membershipId: user.membershipId,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  } as Principal;
}

const northstar = () => contextOf(world.northstar.organizationId, world.northstar.owner, 'owner');
const northstarOwner = () =>
  principalOf(world.northstar.organizationId, world.northstar.owner, 'owner');
const twin = () => contextOf(world.twin.organizationId, world.twin.owner, 'owner');
const twinOwner = () => principalOf(world.twin.organizationId, world.twin.owner, 'owner');

beforeAll(async () => {
  db = await startTestDatabase();
  world = await seedTwoTenants(db.admin);
  pool = createTenantPool({
    url: db.runtimeUrl,
    connectionLimit: 8,
    statementTimeoutMs: RUNTIME_STATEMENT_TIMEOUT_MS,
  });
  database = new TenantDatabase(pool, { guardMode: 'enforce' });
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

beforeEach(async () => {
  await db.admin.query('delete from ai_employees');
  await db.admin.query("delete from memberships where kind = 'ai'");
  await db.admin.query('delete from users where email like ?', [`%@${AI_EMPLOYEE_EMAIL_DOMAIN}`]);
});

afterAll(async () => {
  await pool?.end();
  await db?.stop();
});

describe('hire', () => {
  it('writes the user, the ai membership, the companion row and one audit row', async () => {
    const view = await service.hire(northstar(), northstarOwner(), {
      displayName: 'Mat',
      jobTitle: 'Social media designer',
    });
    const [user] = await rows(
      'select u.id, u.email from users u join memberships m on m.user_id = u.id where m.id = ?',
      [view.membershipId],
    );
    expect(String(user?.['email'])).toMatch(new RegExp(`@${AI_EMPLOYEE_EMAIL_DOMAIN}$`));
    // No credential of any kind: no password row (sign-in and reset are refused doors, 60-04).
    expect(await rows('select 1 from user_passwords where user_id = ?', [user?.['id']])).toEqual(
      [],
    );
    const [member] = await rows('select kind, role, status from memberships where id = ?', [
      view.membershipId,
    ]);
    expect(member).toMatchObject({ kind: 'ai', role: 'member', status: 'active' });
    const audits = await rows(
      'select action from audit_events where organization_id = ? and action = ?',
      [world.northstar.organizationId, AI_EMPLOYEE_AUDIT.hired],
    );
    expect(audits).toHaveLength(1);
    const list = await service.list(northstar(), northstarOwner());
    expect(list.aiEmployees.map((ai) => ai.displayName)).toEqual(['Mat']);
    expect(list.aiEmployees[0]?.sponsor.displayName).toBe(world.northstar.owner.displayName);
  });

  it('two racing hires for the last seat: exactly one is written', async () => {
    for (let i = 1; i <= 4; i += 1) {
      await service.hire(northstar(), northstarOwner(), {
        displayName: `Seat ${i}`,
        jobTitle: 'x',
      });
    }
    const outcomes = await Promise.allSettled([
      service.hire(northstar(), northstarOwner(), { displayName: 'Race A', jobTitle: 'x' }),
      service.hire(northstar(), northstarOwner(), { displayName: 'Race B', jobTitle: 'x' }),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find((o) => o.status === 'rejected')).toMatchObject({
      reason: { status: 409, auditCode: 'ai_employee:workspace_limit' },
    });
    const [count] = await rows('select count(*) as n from ai_employees where organization_id = ?', [
      world.northstar.organizationId,
    ]);
    expect(Number(count?.['n'])).toBe(5);
  });
});

describe('another workspace', () => {
  it('reads and changes are 404, and the twin list is empty', async () => {
    const view = await service.hire(northstar(), northstarOwner(), {
      displayName: 'Mat',
      jobTitle: 'Designer',
    });
    await expect(service.get(twin(), twinOwner(), view.id)).rejects.toMatchObject({ status: 404 });
    await expect(
      service.pause(twin(), twinOwner(), view.id, { version: view.version }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.retire(twin(), twinOwner(), view.id, { version: view.version }),
    ).rejects.toMatchObject({ status: 404 });
    expect((await service.list(twin(), twinOwner())).aiEmployees).toEqual([]);
  });
});

describe('retire', () => {
  it('offboards the membership in the same transaction', async () => {
    const view = await service.hire(northstar(), northstarOwner(), {
      displayName: 'Mat',
      jobTitle: 'Designer',
    });
    const retired = await service.retire(northstar(), northstarOwner(), view.id, {
      version: view.version,
    });
    expect(retired.status).toBe('retired');
    const [member] = await rows('select status from memberships where id = ?', [view.membershipId]);
    expect(member?.['status']).toBe('offboarded');
  });
});

describe('the member role paths never touch an AI member (60-04 interim door)', () => {
  it('changeRole reads it as not found and bulk assign writes nothing', async () => {
    const view = await service.hire(northstar(), northstarOwner(), {
      displayName: 'Mat',
      jobTitle: 'Designer',
    });
    const memberships = new MembershipsRepository();
    await expect(
      database.transaction(northstar(), async (tx) => {
        const row = await memberships.requireById(tx, northstar(), view.membershipId);
        return memberships.changeRole(tx, northstar(), view.membershipId, row.version, 'org_admin');
      }),
    ).rejects.toMatchObject({ name: 'MembershipNotFoundError' });
    const applied = await database.transaction(northstar(), (tx) =>
      new MemberBulkRoleRepository().assignRole(
        tx,
        northstar(),
        view.membershipId,
        'workspace_admin',
      ),
    );
    expect(applied).toBe(false);
    const [member] = await rows('select role from memberships where id = ?', [view.membershipId]);
    expect(member?.['role']).toBe('member');
  });
});
