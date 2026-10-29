import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { uuidv7 } from '@tmanage/domain';
import {
  createSupportSessionSweepStore,
  createWorkerDatabase,
  sweepSupportSessions,
} from '@tmanage/worker';
import type { WorkerDatabase } from '@tmanage/worker';
import { TenantDatabase } from '../src/common/database/tenant-context.js';
import { MembershipResolver } from '../src/modules/tenancy/membership-resolver.repository.js';
import type { PlatformAdminActor } from '../src/modules/platform-admin/platform-admin.guard.js';
import { PlatformAuditService } from '../src/modules/platform-admin/platform-audit.service.js';
import { SupportSessionService } from '../src/modules/platform-admin/support/support-session.service.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * PLAT-012 against a real server — Support mode (platform-admin v2, PA-05, SPEC §3.2 / A8).
 *
 * 1. Entering inserts a hidden `platform_support` membership tied to a live session; the resolver
 *    resolves it with the session, both audit logs record the visit, and a second Enter returns the
 *    same session.
 * 2. Extend moves the end by 30 minutes; Exit offboards the hidden row, so the resolver refuses
 *    the admin at once, and a second Exit changes nothing.
 * 3. An admin who is also a real member has their own row upgraded and put back on exit.
 * 4. The worker sweep ends an expired session and takes its membership away.
 * 5. The banner read ends a session reached from another browser session (sign-out cleanup).
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let workerDb: WorkerDatabase;
let service: SupportSessionService;
let resolver: MembershipResolver;
const BROWSER = uuidv7();

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

function request() {
  return { correlationId: uuidv7(), ip: '203.0.113.7', userAgent: 'vitest' };
}

function actorFor(userId: string, email: string): PlatformAdminActor {
  return {
    account: { userId, email, displayName: 'Platform', emailVerified: true, mfaEnabled: false },
    sessionId: BROWSER,
    stepUp: { expiresAt: new Date(Date.now() + 10 * 60_000), mfaVerified: false },
    permissions: ['platform.orgs.enter', 'platform.activity.view', 'platform.orgs.lifecycle'],
  };
}

function resolve(userId: string, organizationId: string) {
  return resolver.resolve({ userId, organization: { organizationId }, correlationId: uuidv7() });
}

async function membershipOf(organizationId: string, userId: string) {
  const [row] = await observe(
    `select role, status, has_org_wide_scope, platform_support_session_id
       from memberships where organization_id = ? and user_id = ?`,
    [organizationId, userId],
  );
  return row;
}

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
  workerDb = createWorkerDatabase({ url: db.url, connectionLimit: 2, statementTimeoutMs: 15_000 });
  service = new SupportSessionService(tenant, new PlatformAuditService(tenant));
  resolver = new MembershipResolver(tenant);
});

afterAll(async () => {
  await workerDb?.end();
  await db?.stop();
});

describe('Support mode (PLAT-012)', () => {
  it('enters with a hidden membership, resolves it, audits both sides, and is idempotent', async () => {
    const admin = actorFor(world.platformAdmin.id, world.platformAdmin.email);
    const orgId = world.northstar.organizationId;
    const started = await service.start(
      admin,
      orgId,
      { minutes: 120, reason: 'Customer asked for help' },
      request(),
    );
    expect(started.redirectTo).toContain(started.slug);

    const membership = await membershipOf(orgId, world.platformAdmin.id);
    expect(membership).toMatchObject({
      role: 'platform_support',
      status: 'active',
      platform_support_session_id: started.id,
    });
    expect(Number(membership?.['has_org_wide_scope'])).toBe(1);

    const resolved = await resolve(world.platformAdmin.id, orgId);
    expect(resolved.supportSession?.id).toBe(started.id);

    const orgAudit = await observe(
      `select action, effective_actor_id from audit_events
        where organization_id = ? and action = 'support.session_started'`,
      [orgId],
    );
    expect(orgAudit).toHaveLength(1);
    expect(orgAudit[0]?.['effective_actor_id']).toBe(world.platformAdmin.id);
    const platformAudit = await observe(
      `select count(*) as n from platform_admin_audit_events
        where action = 'platform.support_session_started'`,
    );
    expect(Number(platformAudit[0]?.['n'])).toBe(1);

    const again = await service.start(admin, orgId, { minutes: 30 }, request());
    expect(again.id).toBe(started.id);
  });

  it('extends by 30 minutes, exits, and refuses the admin at once after', async () => {
    const admin = actorFor(world.platformAdmin.id, world.platformAdmin.email);
    const orgId = world.northstar.organizationId;
    const [open] = await observe(
      'select id, expires_at from platform_support_sessions where organization_id = ? and ended_at is null',
      [orgId],
    );
    const sessionId = String(open?.['id']);
    const before = new Date(open?.['expires_at'] as Date).getTime();
    const extended = await service.extend(admin, sessionId, { minutes: 30 }, request());
    expect(new Date(extended.session.expiresAt).getTime() - before).toBe(30 * 60_000);

    const ended = await service.end(admin, sessionId, {}, request());
    expect(ended.session.live).toBe(false);
    expect(ended.session.endedReason).toBe('exited');
    expect((await membershipOf(orgId, world.platformAdmin.id))?.['status']).toBe('offboarded');
    await expect(resolve(world.platformAdmin.id, orgId)).rejects.toThrow();

    const endedAudit = await observe(
      `select count(*) as n from audit_events where organization_id = ? and action = 'support.session_ended'`,
      [orgId],
    );
    expect(Number(endedAudit[0]?.['n'])).toBe(1);

    // A second Exit changes nothing and writes no second audit row.
    await service.end(admin, sessionId, {}, request());
    const still = await observe(
      `select count(*) as n from audit_events where organization_id = ? and action = 'support.session_ended'`,
      [orgId],
    );
    expect(Number(still[0]?.['n'])).toBe(1);
  });

  it('re-enters through the same hidden row after an exit', async () => {
    const admin = actorFor(world.platformAdmin.id, world.platformAdmin.email);
    const orgId = world.northstar.organizationId;
    const started = await service.start(admin, orgId, { minutes: 30 }, request());
    expect((await membershipOf(orgId, world.platformAdmin.id))?.['status']).toBe('active');
    expect((await resolve(world.platformAdmin.id, orgId)).supportSession?.id).toBe(started.id);
    await service.end(admin, started.id, {}, request());
  });

  it("upgrades an admin's own membership and puts it back on exit", async () => {
    const member = world.twin.owner;
    const admin = actorFor(member.id, 'twin-owner@tmanage.test');
    const orgId = world.twin.organizationId;
    const before = await membershipOf(orgId, member.id);
    const started = await service.start(admin, orgId, { minutes: 30 }, request());
    expect((await membershipOf(orgId, member.id))?.['role']).toBe('platform_support');
    const [session] = await observe(
      'select previous_role from platform_support_sessions where id = ?',
      [started.id],
    );
    expect(String(session?.['previous_role'])).toContain(String(before?.['role']));

    await service.end(admin, started.id, {}, request());
    const after = await membershipOf(orgId, member.id);
    expect(after?.['role']).toBe(before?.['role']);
    expect(after?.['status']).toBe(before?.['status']);
    expect(after?.['platform_support_session_id']).toBeNull();
    expect((await resolve(member.id, orgId)).role).toBe(before?.['role']);
  });

  it('the worker sweep ends an expired session and takes its membership away', async () => {
    const admin = actorFor(world.platformAdmin.id, world.platformAdmin.email);
    const orgId = world.twin.organizationId;
    const started = await service.start(admin, orgId, { minutes: 30 }, request());
    await db.admin.execute('update platform_support_sessions set expires_at = ? where id = ?', [
      new Date(Date.now() - 60_000),
      started.id,
    ]);
    const result = await sweepSupportSessions(createSupportSessionSweepStore(workerDb));
    expect(result.ended).toBe(1);
    const [row] = await observe(
      'select ended_reason, ended_at from platform_support_sessions where id = ?',
      [started.id],
    );
    expect(row?.['ended_reason']).toBe('expired');
    expect(row?.['ended_at']).not.toBeNull();
    expect((await membershipOf(orgId, world.platformAdmin.id))?.['status']).toBe('offboarded');
    const orgAudit = await observe(
      `select count(*) as n from audit_events
        where organization_id = ? and action = 'support.session_ended' and platform_support_session_id = ?`,
      [orgId, started.id],
    );
    expect(Number(orgAudit[0]?.['n'])).toBe(1);
    // A second pass finds nothing left to do.
    expect((await sweepSupportSessions(createSupportSessionSweepStore(workerDb))).ended).toBe(0);
  });

  it('ends a session the banner reads from another browser session (signed out)', async () => {
    const admin = actorFor(world.platformAdmin.id, world.platformAdmin.email);
    const orgId = world.northstar.organizationId;
    const started = await service.start(admin, orgId, { minutes: 30 }, request());
    const same = await service.forMember(
      { id: started.id, adminUserId: world.platformAdmin.id },
      BROWSER,
      uuidv7(),
    );
    expect(same?.id).toBe(started.id);
    const other = await service.forMember(
      { id: started.id, adminUserId: world.platformAdmin.id },
      uuidv7(),
      uuidv7(),
    );
    expect(other).toBeNull();
    const [row] = await observe('select ended_reason from platform_support_sessions where id = ?', [
      started.id,
    ]);
    expect(row?.['ended_reason']).toBe('signed_out');
  });
});
