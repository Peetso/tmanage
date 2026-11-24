import { createHash } from 'node:crypto';
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
  // Retire's revocation case leaves an agent key, a connector grant and its token behind.
  const aiUsers = [`%@${AI_EMPLOYEE_EMAIL_DOMAIN}`];
  await db.admin.query(
    'delete t from personal_access_tokens t join users u on u.id = t.user_id where u.email like ?',
    aiUsers,
  );
  await db.admin.query(
    `delete a from oauth_access_tokens a join oauth_grants g on g.id = a.grant_id
       join users u on u.id = g.user_id where u.email like ?`,
    aiUsers,
  );
  await db.admin.query(
    'delete g from oauth_grants g join users u on u.id = g.user_id where u.email like ?',
    aiUsers,
  );
  await db.admin.query('delete from ai_employees');
  await db.admin.query("delete from memberships where kind = 'ai'");
  // 60-07: a hire saves his projects as project memberships of his user row.
  await db.admin.query(
    'delete pm from project_memberships pm join users u on u.id = pm.user_id where u.email like ?',
    [`%@${AI_EMPLOYEE_EMAIL_DOMAIN}`],
  );
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
      projectIds: [world.northstar.projectId],
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
        projectIds: [world.northstar.projectId],
      });
    }
    const outcomes = await Promise.allSettled([
      service.hire(northstar(), northstarOwner(), {
        displayName: 'Race A',
        jobTitle: 'x',
        projectIds: [world.northstar.projectId],
      }),
      service.hire(northstar(), northstarOwner(), {
        displayName: 'Race B',
        jobTitle: 'x',
        projectIds: [world.northstar.projectId],
      }),
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
      projectIds: [world.northstar.projectId],
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
      projectIds: [world.northstar.projectId],
    });
    // 60-10: pause and resume first (the e2e journey's path), each one versioned write.
    const paused = await service.pause(northstar(), northstarOwner(), view.id, {
      version: view.version,
    });
    expect(paused).toMatchObject({ status: 'paused', pausedReason: 'manual' });
    const resumed = await service.resume(northstar(), northstarOwner(), view.id, {
      version: paused.version,
    });
    expect(resumed.status).toBe('active');
    const retired = await service.retire(northstar(), northstarOwner(), view.id, {
      version: resumed.version,
    });
    expect(retired.status).toBe('retired');
    const [member] = await rows('select status from memberships where id = ?', [view.membershipId]);
    expect(member?.['status']).toBe('offboarded');
  });

  it('marks his agent keys and connector grants revoked, with their tokens, and audits them', async () => {
    const view = await service.hire(northstar(), northstarOwner(), {
      displayName: 'Mat',
      jobTitle: 'Designer',
      projectIds: [world.northstar.projectId],
    });
    const key = await service.createKey(northstar(), northstarOwner(), view.id, {
      name: 'Mat on Claude',
      lifetimeDays: 30,
    });
    const [ai] = await rows('select user_id from memberships where id = ?', [view.membershipId]);
    const org = world.northstar.organizationId;
    const clientPk = uuidv7();
    const grantId = uuidv7();
    await db.admin.execute(
      `insert into oauth_clients (id, client_id, kind, name, redirect_uris_json)
       values (?, ?, 'dcr', 'Claude', json_array('https://claude.ai/api/mcp/auth_callback'))`,
      [clientPk, `t-60-03-${clientPk}`],
    );
    await db.admin.execute(
      `insert into oauth_grants (id, organization_id, client_pk, membership_id, user_id, scopes)
       values (?, ?, ?, ?, ?, 'tmanage:read')`,
      [grantId, org, clientPk, view.membershipId, ai?.['user_id']],
    );
    await db.admin.execute(
      `insert into oauth_access_tokens (token_hash, grant_id, family_id, audience, scopes, expires_at)
       values (?, ?, ?, '/mcp', 'tmanage:read', date_add(utc_timestamp(3), interval 1 hour))`,
      [createHash('sha256').update(`t-60-03-${grantId}`).digest('hex'), grantId, uuidv7()],
    );

    await service.retire(northstar(), northstarOwner(), view.id, { version: view.version });

    const [token] = await rows('select revoked_at from personal_access_tokens where id = ?', [
      key.id,
    ]);
    expect(token?.['revoked_at']).not.toBeNull();
    const [grant] = await rows('select revoked_at from oauth_grants where id = ?', [grantId]);
    expect(grant?.['revoked_at']).not.toBeNull();
    const live = await rows(
      'select 1 from oauth_access_tokens where grant_id = ? and revoked_at is null',
      [grantId],
    );
    expect(live).toEqual([]);
    const [event] = await rows(
      "select metadata_json from audit_events where action = 'ai_employee.retired' and object_id = ?",
      [view.id],
    );
    const raw: unknown = event?.['metadata_json'];
    const metadata: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
    expect(metadata).toMatchObject({
      keys_revoked: 1,
      revoked_key_ids: [key.id],
      connectors_revoked: 1,
      revoked_grant_ids: [grantId],
    });
  });
});

describe('the member role paths never touch an AI member (60-04 interim door)', () => {
  it('changeRole reads it as not found and bulk assign writes nothing', async () => {
    const view = await service.hire(northstar(), northstarOwner(), {
      displayName: 'Mat',
      jobTitle: 'Designer',
      projectIds: [world.northstar.projectId],
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
