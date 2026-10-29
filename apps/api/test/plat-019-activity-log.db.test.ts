import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { PLATFORM_PERMISSIONS, auditObjectTypeFor, uuidv7 } from '@tmanage/domain';
import { TenantDatabase } from '../src/common/database/tenant-context.js';
import { PlatformAdminRepository } from '../src/modules/platform-admin/platform-admin.repository.js';
import type { PlatformAdminActor } from '../src/modules/platform-admin/platform-admin.guard.js';
import { PlatformAuditService } from '../src/modules/platform-admin/platform-audit.service.js';
import { ActivityRepository } from '../src/modules/platform-admin/activity/activity.repository.js';
import { PlatformActivityService } from '../src/modules/platform-admin/activity/activity.service.js';
import { ExportsRepository } from '../src/modules/platform-admin/activity/exports.repository.js';
import { SupportSessionsRepository } from '../src/modules/platform-admin/support/support-sessions.repository.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * PLAT-019 against a real server — Activity & access (platform-admin v2, PA-09).
 *
 * 1. C1 lists every organization's actions on the metadata path, filters by organization, and
 *    switches to the tenant path for "has changes" (which reads `audit_event_changes`).
 * 2. C2 detail returns the field changes with redacted values nulled, and opening it is itself a
 *    platform audit row (`platform.action_detail_viewed`). An event asked for under another
 *    organization's id is a 404.
 * 3. IPs and devices are hidden without `platform.activity.detail`.
 * 4. C3: ending a session needs a reason, revokes only that session and records
 *    `platform.session_ended`; ten failures from one IP are a burst.
 * 5. C4 lists the platform admin log with the organization's name.
 */

let db: TestDatabase;
let world: SeedWorld;
let service: PlatformActivityService;

const ctx = {
  correlationId: '0199aa00-0000-7000-8000-00000000c019',
  ip: '203.0.113.19',
  userAgent: 'Firefox/131',
};
const REASON = 'Ticket #5120 — lost laptop';
const ACTION = 'project_membership.granted';

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

function actor(permissions: readonly string[] = PLATFORM_PERMISSIONS): PlatformAdminActor {
  return {
    account: {
      userId: world.platformAdmin.id,
      email: world.platformAdmin.email,
      displayName: 'Peter',
      emailVerified: true,
      mfaEnabled: true,
    },
    sessionId: uuidv7(),
    stepUp: null,
    source: 'env',
    preset: 'super_admin',
    permissions: [...permissions],
  };
}

async function auditEvent(organizationId: string, actorUserId: string): Promise<string> {
  const id = uuidv7();
  await db.admin.query(
    `insert into audit_events
       (id, organization_id, actor_user_id, effective_actor_id, action, object_type, object_id,
        result, correlation_id, metadata_json, created_at, ip, user_agent)
     values (?, ?, ?, ?, ?, ?, ?, 'allowed', ?, ?, current_timestamp(3), '198.51.100.7', 'Chrome/130')`,
    [
      id,
      organizationId,
      actorUserId,
      actorUserId,
      ACTION,
      auditObjectTypeFor(ACTION),
      uuidv7(),
      uuidv7(),
      JSON.stringify({ project_id: uuidv7() }),
    ],
  );
  return id;
}

let northEvent = '';
let twinEvent = '';

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  const tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
  service = new PlatformActivityService({
    admins: new PlatformAdminRepository(tenant),
    activity: new ActivityRepository(tenant),
    exports: new ExportsRepository(tenant),
    supportSessions: new SupportSessionsRepository(tenant),
    audit: new PlatformAuditService(tenant),
    allowlist: [world.platformAdmin.email],
    objectStore: null,
  });
  northEvent = await auditEvent(world.northstar.organizationId, world.northstar.owner.id);
  twinEvent = await auditEvent(world.twin.organizationId, world.twin.owner.id);
  await db.admin.query(
    `insert into audit_event_changes
       (id, organization_id, audit_event_id, field, before_value, after_value, redacted, created_at)
     values (?, ?, ?, 'role', 'viewer', 'manager', 0, current_timestamp(3)),
            (?, ?, ?, 'password', 'old', 'new', 1, current_timestamp(3))`,
    [
      uuidv7(),
      world.northstar.organizationId,
      northEvent,
      uuidv7(),
      world.northstar.organizationId,
      northEvent,
    ],
  );
});

afterAll(async () => {
  await db?.stop();
});

describe('C1 actions', () => {
  it('lists every organization on the metadata path, with totals', async () => {
    const page = await service.actions(actor(), { limit: '100' }, ctx);
    const ids = page.actions.map((row) => row.id);
    expect(ids).toContain(northEvent);
    expect(ids).toContain(twinEvent);
    expect(page.totals.total).toBeGreaterThanOrEqual(2);
    const north = page.actions.find((row) => row.id === northEvent);
    expect(north?.organizationName).toBeTruthy();
    expect(north?.ip).toBe('198.51.100.7');
  });

  it('filters by organization, and "has changes" runs on the tenant path', async () => {
    const page = await service.actions(
      actor(),
      { organizationId: world.northstar.organizationId, hasChanges: 'true' },
      ctx,
    );
    expect(page.actions.map((row) => row.id)).toEqual([northEvent]);
  });

  it('refuses "has changes" without an organization', async () => {
    await expect(service.actions(actor(), { hasChanges: 'true' }, ctx)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('hides IPs and devices without the detail permission', async () => {
    const page = await service.actions(
      actor(['platform.activity.view']),
      { organizationId: world.northstar.organizationId },
      ctx,
    );
    expect(page.showsOrigin).toBe(false);
    expect(page.actions.every((row) => row.ip === null && row.userAgent === null)).toBe(true);
  });
});

describe('C2 detail', () => {
  it('returns the changes with redacted values nulled and records the view', async () => {
    const detail = await service.actionDetail(
      actor(),
      world.northstar.organizationId,
      northEvent,
      ctx,
    );
    const role = detail.changes.find((change) => change.field === 'role');
    const secret = detail.changes.find((change) => change.field === 'password');
    expect(role).toMatchObject({ before: 'viewer', after: 'manager', redacted: false });
    expect(secret).toMatchObject({ before: null, after: null, redacted: true });
    const viewed = await observe(
      `select organization_id, after_json from platform_admin_audit_events
        where action = 'platform.action_detail_viewed' and after_json like ?`,
      [`%${northEvent}%`],
    );
    expect(viewed).toHaveLength(1);
    expect(viewed[0]?.['organization_id']).toBe(world.northstar.organizationId);
  });

  it("is a 404 for an event asked for under another organization's id", async () => {
    await expect(
      service.actionDetail(actor(), world.northstar.organizationId, twinEvent, ctx),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('C3 access', () => {
  async function liveSession(userId: string): Promise<string> {
    const id = uuidv7();
    await db.admin.query(
      `insert into sessions (id, user_id, refresh_token_hash, user_agent, expires_at, created_at, ip_first, ip_last)
       values (?, ?, ?, 'Chrome/130', date_add(now(3), interval 30 day), now(3), '41.33.10.8', '41.33.10.8')`,
      [id, userId, id.replace(/-/gu, '').padEnd(64, '0')],
    );
    return id;
  }

  it('ends one session with a reason, and only that one', async () => {
    const end = await liveSession(world.northstar.designer.id);
    const keep = await liveSession(world.northstar.designer.id);
    await expect(service.endSession(actor(), end, {}, ctx)).rejects.toMatchObject({
      status: 400,
    });
    const ended = await service.endSession(actor(), end, { reason: REASON }, ctx);
    expect(ended).toEqual({ ended: true, userId: world.northstar.designer.id });
    const rows = await observe('select id, revoked_at from sessions where id in (?, ?)', [
      end,
      keep,
    ]);
    const byId = new Map(rows.map((row) => [String(row['id']), row['revoked_at']]));
    expect(byId.get(end)).not.toBeNull();
    expect(byId.get(keep)).toBeNull();
    const [audit] = await observe(
      `select reason, target_id from platform_admin_audit_events
        where action = 'platform.session_ended' and after_json like ?`,
      [`%${end}%`],
    );
    expect(audit).toMatchObject({ reason: REASON, target_id: world.northstar.designer.id });
    await expect(service.endSession(actor(), end, { reason: REASON }, ctx)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('lists live sessions platform-wide', async () => {
    const page = await service.sessions(actor(), { userId: world.northstar.designer.id }, ctx);
    expect(page.sessions.length).toBeGreaterThanOrEqual(1);
    expect(page.sessions.every((row) => row.active)).toBe(true);
  });

  it('flags ten failed sign-ins from one IP as a burst', async () => {
    for (let i = 0; i < 10; i += 1) {
      await db.admin.query(
        `insert into authentication_events (id, user_id, action, outcome, reason, ip, user_agent, occurred_at)
         values (?, ?, 'password_sign_in', 'failed', 'bad_password', '185.220.101.4', 'curl/8', now(3))`,
        [uuidv7(), i % 2 === 0 ? world.northstar.owner.id : world.twin.owner.id],
      );
    }
    const view = await service.suspicious({ window: '1h' }, ctx);
    const burst = view.patterns.find((pattern) => pattern.source === '185.220.101.4');
    expect(burst).toMatchObject({ kind: 'ip_burst', failures: 10, accountsHit: 2 });
    expect(view.geoAvailable).toBe(false);
    const signIns = await service.signIns(actor(), { ip: '185.220.101.4' }, ctx);
    expect(signIns.signIns).toHaveLength(10);
  });
});

describe('C4 platform admins', () => {
  it('lists the platform log with organization names', async () => {
    const page = await service.platformActions(actor(), { action: 'platform.session_ended' }, ctx);
    expect(page.total).toBeGreaterThanOrEqual(1);
    expect(page.actions[0]?.reason).toBe(REASON);
    const viewed = await service.platformActions(
      actor(),
      { action: 'platform.action_detail_viewed' },
      ctx,
    );
    expect(viewed.actions[0]?.organizationName).toBeTruthy();
  });
});
