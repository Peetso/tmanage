import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import { parseSeedKeys } from '@tmanage/config';
import type { Principal, Role } from '@tmanage/domain';
import { createTenantPool } from '../src/common/database/connection.js';
import {
  TenantDatabase,
  createServiceContext,
  createTenantContext,
} from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { AiEmployeesRepository } from '../src/modules/ai-employees/ai-employees.repository.js';
import { AiEmployeesService } from '../src/modules/ai-employees/ai-employees.service.js';
import type { AiEmployeeView } from '../src/modules/ai-employees/ai-employees.service.js';
import { ApprovalsRepository } from '../src/modules/approvals/approvals.repository.js';
import { AuditEventsRepository } from '../src/modules/audit/audit-events.repository.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import {
  AiEmployeeCredentialRefusedError,
  CredentialsRepository,
} from '../src/modules/identity/credentials.repository.js';
import { createSeedCipher } from '../src/modules/identity/seed-cipher.js';
import { SessionService } from '../src/modules/identity/session.service.js';
import { ScimRepository } from '../src/modules/scim/scim.repository.js';
import { InviteeAccountsRepository } from '../src/modules/tenancy/invitee-accounts.repository.js';
import { MembershipsRepository } from '../src/modules/tenancy/memberships.repository.js';
import { OffboardingService } from '../src/modules/tenancy/offboarding.service.js';
import { RUNTIME_STATEMENT_TIMEOUT_MS, startTestDatabase } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld, SeededUser } from './seed-two-tenants.js';

/**
 * 60-04 (plan 60 v2 §4.1, §4.5, security test 1) on MariaDB 11.8 through the guarded
 * TenantDatabase and the app grants. FOR THE TEST PHASE (lane V did not run it, laptop rule):
 *
 * 1. The one session writer refuses an AI employee's user (every sign-in door at once).
 * 2. The one password writer refuses it (set, change, reset).
 * 3. SCIM never lists or finds an AI member.
 * 4. An AI member is never an internal reviewer / step approver candidate.
 * 5. People offboarding refuses an AI member (Retire is its only way out).
 * 6. Offboarding a sponsor pauses their active AI employees (`sponsor_left`) in the same
 *    transaction, and the offboarding audit row counts them.
 */

/** Only the password writer is exercised; the cipher is never used (no factor seeds). */
const SEED_CIPHER = createSeedCipher(
  parseSeedKeys(`1:${Buffer.alloc(32, 0x11).toString('base64url')}`),
);

let db: TestDatabase;
let world: SeedWorld;
let pool: Pool | undefined;
let database: TenantDatabase;
let service: AiEmployeesService;
let audit: AuditService;
let mat: AiEmployeeView;

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
    policyVersion: 't-60-04',
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

beforeAll(async () => {
  db = await startTestDatabase();
  world = await seedTwoTenants(db.admin);
  pool = createTenantPool({
    url: db.runtimeUrl,
    connectionLimit: 4,
    statementTimeoutMs: RUNTIME_STATEMENT_TIMEOUT_MS,
  });
  database = new TenantDatabase(pool, { guardMode: 'enforce' });
  audit = new AuditService(database, new AuditEventsRepository());
  service = new AiEmployeesService({
    database,
    audit,
    repository: new AiEmployeesRepository(),
    memberships: new MembershipsRepository(),
    accounts: new InviteeAccountsRepository(),
    enabled: true,
  });
  // Sponsored by the manager, so case 6 can offboard the sponsor without touching the owner.
  mat = await service.hire(owner(), ownerPrincipal(), {
    displayName: 'Mat',
    jobTitle: 'Designer',
    sponsorMembershipId: world.northstar.manager.membershipId,
  });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await db?.stop();
});

const aiUserId = async (): Promise<string> => {
  const [row] = await rows('select user_id from memberships where id = ?', [mat.membershipId]);
  return String(row?.['user_id']);
};

describe('identity doors', () => {
  it('no session starts for the AI user', async () => {
    const sessions = new SessionService(database, {
      cookieName: 'tm',
      sessionSecret: 'local_dev_only_session_secret_value_for_t_60_04_doors',
      accessTtlSeconds: 900,
      refreshTtlSeconds: 86_400,
      refreshCookiePath: '/v1/sessions/refresh',
      secureCookies: false,
      csrfSecret: 'local_dev_only_csrf_secret_value_for_t_60_04_doors',
      csrfCookieName: 'tm_csrf',
    });
    const userId = await aiUserId();
    await expect(sessions.start({ userId, correlationId: uuidv7() })).rejects.toMatchObject({
      status: 403,
    });
    expect(await rows('select 1 from sessions where user_id = ?', [userId])).toEqual([]);
  });

  it('the password writer refuses the AI user', async () => {
    const userId = await aiUserId();
    await expect(
      database.identityTransaction(
        { correlationId: uuidv7(), tables: ['users', 'user_passwords'] },
        (tx) => new CredentialsRepository(SEED_CIPHER).setPassword(tx, userId, '$argon2id$v=19$x'),
      ),
    ).rejects.toBeInstanceOf(AiEmployeeCredentialRefusedError);
    expect(await rows('select 1 from user_passwords where user_id = ?', [userId])).toEqual([]);
  });
});

describe('SCIM never sees an AI member', () => {
  it('list and find skip it', async () => {
    const context = createServiceContext({
      organizationId: world.northstar.organizationId,
      correlationId: uuidv7(),
      policyVersion: 't-60-04',
    });
    const scim = new ScimRepository();
    const listed = await database.read(context, (runner) =>
      scim.listUsers(runner, context, undefined, 0, 100),
    );
    expect(listed.rows.map((row) => row.membershipId)).not.toContain(mat.membershipId);
    expect(
      await database.read(context, (runner) => scim.findUser(runner, context, mat.membershipId)),
    ).toBeNull();
  });
});

describe('approver doors', () => {
  it('an AI member is never an internal reviewer candidate', async () => {
    const userId = await aiUserId();
    const candidates = await database.read(owner(), (runner) =>
      new ApprovalsRepository().internalReviewerCandidates(
        runner,
        owner(),
        world.northstar.projectId,
        [userId, world.northstar.owner.id],
      ),
    );
    expect(candidates.map((c) => c.userId)).toEqual([world.northstar.owner.id]);
  });
});

describe('offboarding', () => {
  const offboarding = () =>
    new OffboardingService(
      database,
      new MembershipsRepository(),
      audit,
      undefined,
      undefined,
      undefined,
      undefined,
      null,
      new AiEmployeesRepository(),
    );

  it('People offboarding refuses an AI member', async () => {
    await expect(
      offboarding().offboard(owner(), ownerPrincipal(), await aiUserId()),
    ).rejects.toMatchObject({ status: 409, auditCode: 'offboard_ai_employee' });
  });

  it('offboarding the sponsor pauses the AI employee in the same transaction', async () => {
    await offboarding().offboard(owner(), ownerPrincipal(), world.northstar.manager.id);
    const [row] = await rows('select status, paused_reason from ai_employees where id = ?', [
      mat.id,
    ]);
    expect(row).toMatchObject({ status: 'paused', paused_reason: 'sponsor_left' });
    const [event] = await rows(
      "select metadata_json from audit_events where action = 'membership.offboarded' and object_id = ?",
      [world.northstar.manager.membershipId],
    );
    expect(String(event?.['metadata_json'])).toContain('"ai_employees_paused":1');
  });
});
