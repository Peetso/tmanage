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
import { AgentEnforcement } from '../src/modules/ai-employees/enforcement.js';
import { AuditEventsRepository } from '../src/modules/audit/audit-events.repository.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { AgentKeysService } from '../src/modules/personal-access-tokens/agent-keys.js';
import { PersonalAccessTokensService } from '../src/modules/personal-access-tokens/personal-access-tokens.service.js';
import { InviteeAccountsRepository } from '../src/modules/tenancy/invitee-accounts.repository.js';
import { MembershipResolver } from '../src/modules/tenancy/membership-resolver.repository.js';
import { MembershipsRepository } from '../src/modules/tenancy/memberships.repository.js';
import { RUNTIME_STATEMENT_TIMEOUT_MS, startTestDatabase } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld, SeededUser } from './seed-two-tenants.js';

/**
 * 60-06 (plan 60 v2 §4.4, §4.6; security tests 2, 4, 5) on MariaDB 11.8 through the guarded
 * TenantDatabase and the app grants. FOR THE TEST PHASE (lane V did not run it, laptop rule):
 *
 * 1. A real agent key authenticates as an agent (`agent: true`, no human scope).
 * 2. The gate resolves the AI membership: active, sponsor active, capabilities narrowed to role ∩
 *    ceiling ∩ sponsor, never an admin capability; a person's membership answers `null`.
 * 3. A project in `ai_excluded_projects` is returned for removal from the principal.
 * 4. Pausing refuses the next call (`agent:paused`); the switch off refuses it with 404.
 * 5. Workspace B's resolver never resolves the AI user (cross-tenant).
 */

let db: TestDatabase;
let world: SeedWorld;
let pool: Pool | undefined;
let database: TenantDatabase;
let service: AiEmployeesService;
let resolver: MembershipResolver;
let mat: AiEmployeeView;
let keyToken: string;

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await db.admin.query<RowDataPacket[]>(sql, params);
  return result;
}

function contextOf(user: SeededUser, role: Role): TenantContext {
  return createTenantContext({
    organizationId: world.northstar.organizationId,
    userId: user.id,
    membershipId: user.membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor(role),
    policyVersion: 't-60-06',
    correlationId: uuidv7(),
  });
}

function principalOf(user: SeededUser, role: Role): Principal {
  return {
    userId: user.id,
    organizationId: world.northstar.organizationId,
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

function gate(enabled = true): AgentEnforcement {
  return new AgentEnforcement({
    database,
    repository: new AiEmployeesRepository(),
    resolver,
    enabled,
  });
}

async function aiContext(): Promise<TenantContext> {
  const [row] = await rows('select user_id from memberships where id = ?', [mat.membershipId]);
  const resolved = await resolver.resolve({
    userId: String(row?.['user_id']),
    organization: { organizationId: world.northstar.organizationId },
    correlationId: uuidv7(),
  });
  return resolved.context;
}

beforeAll(async () => {
  db = await startTestDatabase();
  world = await seedTwoTenants(db.admin);
  pool = createTenantPool({
    url: db.runtimeUrl,
    connectionLimit: 4,
    statementTimeoutMs: RUNTIME_STATEMENT_TIMEOUT_MS,
  });
  database = new TenantDatabase(pool, { guardMode: 'enforce' });
  resolver = new MembershipResolver(database);
  service = new AiEmployeesService({
    database,
    audit: new AuditService(database, new AuditEventsRepository()),
    repository: new AiEmployeesRepository(),
    memberships: new MembershipsRepository(),
    accounts: new InviteeAccountsRepository(),
    agentKeys: new AgentKeysService(),
    enabled: true,
  });
  mat = await service.hire(owner(), ownerPrincipal(), { displayName: 'Mat', jobTitle: 'Designer' });
  keyToken = (
    await service.createKey(owner(), ownerPrincipal(), mat.id, { name: 'k', lifetimeDays: 30 })
  ).token;
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await db?.stop();
});

describe('60-06 agent enforcement', () => {
  it('a real agent key authenticates as an agent with no human scope', async () => {
    const authed = await new PersonalAccessTokensService(database).authenticate(keyToken, uuidv7());
    expect(authed.agent).toBe(true);
    expect(authed.scopes).toEqual([]);
    expect(authed.membershipId).toBe(mat.membershipId);
  });

  it('the gate passes a person and narrows the AI employee', async () => {
    await expect(
      gate().decide({ context: owner(), agentCredential: false, correlationId: uuidv7() }),
    ).resolves.toBeNull();
    const decision = await gate().decide({
      context: await aiContext(),
      agentCredential: true,
      correlationId: uuidv7(),
    });
    expect(decision?.stamp.aiEmployeeId).toBe(mat.id);
    expect(decision?.capabilities).not.toContain('people.view');
    expect(decision?.capabilities).not.toContain('org.manage');
  });

  it('returns the projects excluded for AI', async () => {
    await db.admin.query(
      'insert into ai_excluded_projects (organization_id, project_id, set_by_membership_id, created_at) values (?, ?, ?, ?)',
      [
        world.northstar.organizationId,
        world.northstar.projectId,
        world.northstar.owner.membershipId,
        new Date('2026-11-22T00:00:00Z'),
      ],
    );
    const decision = await gate().decide({
      context: await aiContext(),
      agentCredential: true,
      correlationId: uuidv7(),
    });
    expect(decision?.excludedProjectIds).toContain(world.northstar.projectId);
  });

  it('the switch off is 404; a paused AI employee is refused on the next call', async () => {
    const context = await aiContext();
    await expect(
      gate(false).decide({ context, agentCredential: true, correlationId: uuidv7() }),
    ).rejects.toMatchObject({ status: 404 });
    await service.pause(owner(), ownerPrincipal(), mat.id, { version: mat.version });
    await expect(
      gate().decide({ context, agentCredential: true, correlationId: uuidv7() }),
    ).rejects.toMatchObject({ status: 403, auditCode: 'agent:paused' });
  });

  it('the other workspace never resolves the AI user', async () => {
    const [row] = await rows('select user_id from memberships where id = ?', [mat.membershipId]);
    await expect(
      resolver.resolve({
        userId: String(row?.['user_id']),
        organization: { organizationId: world.twin.organizationId },
        correlationId: uuidv7(),
      }),
    ).rejects.toThrow();
  });
});
