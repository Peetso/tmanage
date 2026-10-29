import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { uuidv7 } from '@tmanage/domain';
import { TenantDatabase } from '../src/common/database/tenant-context.js';
import {
  MembershipNotResolvedError,
  MembershipResolver,
  ORGANIZATION_DELETED_AT,
} from '../src/modules/tenancy/membership-resolver.repository.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * platform-admin v2 · PA-01 — the membership resolver and the hidden `platform_support` role
 * (SPEC P3, §3.2, §7 item 3), against a real server.
 *
 * A Support session is a real `memberships` row with role `platform_support`, tied to a
 * `platform_support_sessions` row (0240). The resolver accepts that row only while its session is
 * live — not ended and not expired — and then resolves it org-wide with the session attached.
 * An expired or ended session leaves the row unresolved (`no_active_membership`), so a forgotten
 * hidden membership opens nothing. Overrides are loaded with the membership, and a deny never
 * narrows the Support-session role.
 *
 * The deleted-organization refusal (`organization_closed`) reads 0243's
 * `organizations.deleted_at`, which PA-07 adds in wave 2. That case is skipped while the column is
 * absent and runs as soon as 0243 is in the migrations folder.
 *
 * Session times are bound from JS Dates a whole day either side of now, so neither the admin
 * connection's clock nor a time-zone offset can make a live row look expired or the reverse.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

let db: TestDatabase;
let world: SeedWorld;
let resolver: MembershipResolver;
let adminUserId: string;
let membershipId: string;

const resolve = (userId: string) =>
  resolver.resolve({
    userId,
    organization: { slug: 'northstar-studio' },
    correlationId: uuidv7(),
  });

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(MembershipNotResolvedError);
  return (error as MembershipNotResolvedError).code;
}

async function openSession(options: { expiresInMs: number; ended?: boolean }): Promise<string> {
  const id = uuidv7();
  await db.admin.execute(
    `insert into platform_support_sessions
       (id, admin_user_id, browser_session_id, organization_id, membership_id, reason,
        started_at, expires_at, ended_at, ended_reason)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      adminUserId,
      uuidv7(),
      world.northstar.organizationId,
      membershipId,
      'Customer asked for help with the Atlas board',
      new Date(Date.now() - DAY_MS),
      new Date(Date.now() + options.expiresInMs),
      options.ended ? new Date(Date.now() - DAY_MS / 2) : null,
      options.ended ? 'admin_ended' : null,
    ],
  );
  await db.admin.execute('update memberships set platform_support_session_id = ? where id = ?', [
    id,
    membershipId,
  ]);
  return id;
}

async function hasDeletedAtColumn(): Promise<boolean> {
  const [rows] = await db.admin.query<RowDataPacket[]>(
    `select count(*) as n from information_schema.columns
      where table_schema = database() and table_name = 'organizations'
        and column_name = 'deleted_at'`,
  );
  return Number(rows[0]?.['n'] ?? 0) > 0;
}

beforeAll(async () => {
  db = await startTestDatabase();
  resolver = new MembershipResolver(
    new TenantDatabase(db.runtime, { guardMode: 'enforce', onGuardEvent: () => undefined }),
  );
}, 240_000);

afterAll(async () => {
  await db?.stop();
});

beforeEach(async () => {
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  adminUserId = uuidv7();
  await db.admin.execute(
    `insert into users (id, email, display_name, email_verified_at) values (?, ?, ?, now(3))`,
    [adminUserId, 'support@tmanage.test', 'TManage Support'],
  );
  membershipId = uuidv7();
  // Stored with has_org_wide_scope = 0 on purpose: a live session is org-wide whatever the row says.
  await db.admin.execute(
    `insert into memberships (id, organization_id, user_id, role, has_org_wide_scope)
     values (?, ?, ?, 'platform_support', 0)`,
    [membershipId, world.northstar.organizationId, adminUserId],
  );
});

describe('platform_support resolves only while its Support session is live', () => {
  it('a live session resolves org-wide with the session attached', async () => {
    const sessionId = await openSession({ expiresInMs: DAY_MS });
    const resolved = await resolve(adminUserId);
    expect(resolved.role).toBe('platform_support');
    expect(resolved.context.organizationId).toBe(world.northstar.organizationId);
    expect(resolved.hasOrgWideScope).toBe(true);
    expect(resolved.supportSession).toMatchObject({ id: sessionId, adminUserId });
    expect(resolved.supportSession?.expiresAt).toBeInstanceOf(Date);
    expect(resolved.context.capabilities).toContain('billing.manage');
  });

  it('an expired session does not resolve', async () => {
    await openSession({ expiresInMs: -DAY_MS });
    expect(await refusal(resolve(adminUserId))).toBe('no_active_membership');
  });

  it('an ended session does not resolve', async () => {
    await openSession({ expiresInMs: DAY_MS, ended: true });
    expect(await refusal(resolve(adminUserId))).toBe('no_active_membership');
  });

  it('a platform_support row with no session at all does not resolve', async () => {
    expect(await refusal(resolve(adminUserId))).toBe('no_active_membership');
  });

  it('a session for another admin does not open this row', async () => {
    const other = uuidv7();
    await db.admin.execute(
      `insert into users (id, email, display_name, email_verified_at) values (?, ?, ?, now(3))`,
      [other, 'other-support@tmanage.test', 'Other Support'],
    );
    await db.admin.execute(
      `insert into platform_support_sessions
         (id, admin_user_id, browser_session_id, organization_id, membership_id, expires_at)
       values (?, ?, ?, ?, ?, ?)`,
      [
        uuidv7(),
        other,
        uuidv7(),
        world.northstar.organizationId,
        membershipId,
        new Date(Date.now() + DAY_MS),
      ],
    );
    expect(await refusal(resolve(adminUserId))).toBe('no_active_membership');
  });

  it('an ordinary member resolves with no support session', async () => {
    const resolved = await resolve(world.northstar.designer.id);
    expect(resolved.supportSession).toBeNull();
  });
});

describe('overrides load with the membership', () => {
  it("a member's live overrides reach the principal; revoked and expired ones do not", async () => {
    const member = world.northstar.designer;
    const insert = (
      capability: string,
      effect: string,
      extra: { expired?: boolean; revoked?: boolean },
    ) =>
      db.admin.execute(
        `insert into membership_permission_overrides
           (id, organization_id, membership_id, capability, effect, expires_at, created_by,
            revoked_at, revoked_by)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uuidv7(),
          world.northstar.organizationId,
          member.membershipId,
          capability,
          effect,
          extra.expired ? new Date(Date.now() - DAY_MS) : null,
          world.northstar.owner.id,
          extra.revoked ? new Date(Date.now() - DAY_MS) : null,
          extra.revoked ? world.northstar.owner.id : null,
        ],
      );
    await insert('work.delete', 'allow', {});
    await insert('conversation.write', 'deny', {});
    await insert('work.export', 'allow', { expired: true });
    await insert('doc.export', 'allow', { revoked: true });

    const resolved = await resolve(member.id);
    expect(resolved.overrides).toEqual({ allow: ['work.delete'], deny: ['conversation.write'] });
    expect(resolved.context.capabilities).toContain('work.delete');
    expect(resolved.context.capabilities).not.toContain('conversation.write');
    expect(resolved.context.capabilities).not.toContain('work.export');
    expect(resolved.context.capabilities).not.toContain('doc.export');
  });

  it('a deny never narrows the Support-session role', async () => {
    await openSession({ expiresInMs: DAY_MS });
    await db.admin.execute(
      `insert into membership_permission_overrides
         (id, organization_id, membership_id, capability, effect, created_by)
       values (?, ?, ?, 'billing.manage', 'deny', ?)`,
      [uuidv7(), world.northstar.organizationId, membershipId, world.northstar.owner.id],
    );
    const resolved = await resolve(adminUserId);
    expect(resolved.context.capabilities).toContain('billing.manage');
  });
});

describe('a deleted organization refuses its members (0243)', () => {
  it('answers organization_closed once deleted_at is set — skipped until 0243 exists', async (test) => {
    if (!(await hasDeletedAtColumn())) {
      test.skip();
      return;
    }
    ORGANIZATION_DELETED_AT.reset();
    await db.admin.execute('update organizations set deleted_at = ? where id = ?', [
      new Date(Date.now() - DAY_MS),
      world.northstar.organizationId,
    ]);
    expect(await refusal(resolve(world.northstar.designer.id))).toBe('organization_closed');
  });
});
