import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import type { Principal, Role } from '@tmanage/domain';
import { createTenantPool } from '../src/common/database/connection.js';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { AiEmployeesRepository } from '../src/modules/ai-employees/ai-employees.repository.js';
import { AiEmployeesService } from '../src/modules/ai-employees/ai-employees.service.js';
import type { AiEmployeeView } from '../src/modules/ai-employees/ai-employees.service.js';
import { AuditEventsRepository } from '../src/modules/audit/audit-events.repository.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { AgentKeysService } from '../src/modules/personal-access-tokens/agent-keys.js';
import { hashPersonalAccessToken } from '../src/modules/personal-access-tokens/personal-access-token.js';
import { InviteeAccountsRepository } from '../src/modules/tenancy/invitee-accounts.repository.js';
import { MembershipsRepository } from '../src/modules/tenancy/memberships.repository.js';
import { RUNTIME_STATEMENT_TIMEOUT_MS, startTestDatabase } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld, SeededUser } from './seed-two-tenants.js';

/**
 * 60-05 (plan 60 v2 §4.5) agent keys on MariaDB 11.8 through the guarded TenantDatabase and the
 * app grants. FOR THE TEST PHASE (lane V did not run it, laptop rule):
 *
 * 1. A key is a `personal_access_tokens` row on the AI membership: scope `tmanage:agent`, an
 *    expiry 30 days out, `created_by_membership_id` = the caller, only the hash stored.
 * 2. The fourth live key is refused (409); rotation inside the cap works and sets the old key's
 *    end to no later than 24 hours from now; revoke sets `revoked_at` at once.
 * 3. The sponsor may bind without `ai_employee.manage`; another member may not (403).
 * 4. The other tenant's AI employee id is "not found" (BOLA).
 * 5. Every write left one audit row in the same transaction.
 */

let db: TestDatabase;
let world: SeedWorld;
let pool: Pool | undefined;
let database: TenantDatabase;
let service: AiEmployeesService;
let mat: AiEmployeeView;

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await db.admin.query<RowDataPacket[]>(sql, params);
  return result;
}

function contextOf(user: SeededUser, role: Role, organizationId?: string): TenantContext {
  return createTenantContext({
    organizationId: organizationId ?? world.northstar.organizationId,
    userId: user.id,
    membershipId: user.membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor(role),
    policyVersion: 't-60-05',
    correlationId: uuidv7(),
  });
}

function principalOf(user: SeededUser, role: Role, organizationId?: string): Principal {
  return {
    userId: user.id,
    organizationId: organizationId ?? world.northstar.organizationId,
    kind: 'internal',
    role,
    membershipId: user.membershipId,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  } as Principal;
}

const owner = () => contextOf(world.northstar.owner, 'owner');
const ownerPrincipal = () => principalOf(world.northstar.owner, 'owner');
const KEY = { name: 'Mat on Claude', lifetimeDays: 30 };

beforeAll(async () => {
  db = await startTestDatabase();
  world = await seedTwoTenants(db.admin);
  pool = createTenantPool({
    url: db.runtimeUrl,
    connectionLimit: 4,
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
  // Sponsored by the designer, who holds people.view but not ai_employee.manage.
  mat = await service.hire(owner(), ownerPrincipal(), {
    displayName: 'Mat',
    jobTitle: 'Designer',
    projectIds: [world.northstar.projectId],
    sponsorMembershipId: world.northstar.designer.membershipId,
  });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await db?.stop();
});

describe('60-05 agent keys', () => {
  it('stores an agent-scoped, expiring key on the AI membership, hash only', async () => {
    const created = await service.createKey(owner(), ownerPrincipal(), mat.id, KEY);
    const [row] = await rows(
      'select membership_id, scopes, expires_at, created_by_membership_id, token_hash from personal_access_tokens where id = ?',
      [created.id],
    );
    expect(row?.['membership_id']).toBe(mat.membershipId);
    expect(row?.['scopes']).toBe('tmanage:agent');
    expect(row?.['created_by_membership_id']).toBe(world.northstar.owner.membershipId);
    expect(row?.['token_hash']).toBe(hashPersonalAccessToken(created.token));
    const days = (new Date(row?.['expires_at']).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });

  it('the sponsor binds without manage; another member is refused', async () => {
    const designer = contextOf(world.northstar.designer, 'member');
    await expect(
      service.createKey(designer, principalOf(world.northstar.designer, 'member'), mat.id, KEY),
    ).resolves.toMatchObject({ live: true });
    const manager = contextOf(world.northstar.manager, 'manager');
    const managerPrincipal = principalOf(world.northstar.manager, 'manager');
    // The manager holds people.view but not ai_employee.manage and is not the sponsor.
    await expect(service.listKeys(manager, managerPrincipal, mat.id)).rejects.toMatchObject({
      status: 403,
      auditCode: 'ai_employee:not_sponsor',
    });
  });

  it('caps live keys at 3, rotates inside the cap, revokes at once', async () => {
    const third = await service.createKey(owner(), ownerPrincipal(), mat.id, KEY);
    await expect(service.createKey(owner(), ownerPrincipal(), mat.id, KEY)).rejects.toMatchObject({
      status: 409,
      auditCode: 'ai_employee:credential_limit',
    });
    const rotated = await service.rotateKey(owner(), ownerPrincipal(), mat.id, third.id, KEY);
    const [old] = await rows('select expires_at from personal_access_tokens where id = ?', [
      third.id,
    ]);
    expect(new Date(old?.['expires_at']).getTime()).toBeLessThanOrEqual(
      Date.now() + 24 * 60 * 60 * 1000,
    );
    await service.revokeKey(owner(), ownerPrincipal(), mat.id, rotated.id);
    const [revoked] = await rows('select revoked_at from personal_access_tokens where id = ?', [
      rotated.id,
    ]);
    expect(revoked?.['revoked_at']).not.toBeNull();
  });

  it("the other tenant's owner gets not found", async () => {
    const other = world.twin.owner;
    await expect(
      service.listKeys(
        contextOf(other, 'owner', world.twin.organizationId),
        principalOf(other, 'owner', world.twin.organizationId),
        mat.id,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('each write left its audit row', async () => {
    const audits = await rows(
      "select action from audit_events where object_id = ? and action like 'ai_employee.key_%'",
      [mat.id],
    );
    const actions = audits.map((row) => row['action']);
    expect(actions.filter((a) => a === 'ai_employee.key_created')).toHaveLength(3);
    expect(actions).toContain('ai_employee.key_rotated');
    expect(actions).toContain('ai_employee.key_revoked');
  });
});
