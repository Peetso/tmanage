import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { PLATFORM_PERMISSIONS, PLATFORM_PRESETS, uuidv7 } from '@tmanage/domain';
import { TenantDatabase } from '../src/common/database/tenant-context.js';
import { PlatformAdminRepository } from '../src/modules/platform-admin/platform-admin.repository.js';
import type { PlatformAuditInput } from '../src/modules/platform-admin/platform-admin.repository.js';
import { PlatformAdminsRepository } from '../src/modules/platform-admin/platform-admins.repository.js';
import { PlatformTeamService } from '../src/modules/platform-admin/team/team.service.js';
import type { PlatformAdminActor } from '../src/modules/platform-admin/platform-admin.guard.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * PLAT-010 against a real server — the platform admin team (platform-admin v2, PA-02, 0239).
 *
 * 1. A team row resolves to its preset's permissions — the code default, then the stored preset
 *    mapping once a super admin rewrites it — and a custom row to its own list, never with the
 *    super-admin-only key.
 * 2. Every write lands together with its `platform_admin_audit_events` row, which carries the
 *    0239 columns (before/after JSON, IP, device) and a nullable reason.
 * 3. Disabling keeps the row (the app has no DELETE): the guard's lookup then sees `disabled`, and
 *    `anyActive` turns the feature off once nobody active is left.
 * 4. The team service's rules hold over real rows: the server list counts toward "one super admin
 *    must remain", a server-list admin is locked, nobody edits their own row.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let admins: PlatformAdminsRepository;
let lookup: PlatformAdminRepository;

const correlationId = '0199aa00-0000-7000-8000-00000000c010';

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

function audit(fields: Partial<PlatformAuditInput> = {}): PlatformAuditInput {
  return {
    actorUserId: world.platformAdmin.id,
    actorEmail: world.platformAdmin.email,
    action: 'platform.team_admin_added',
    targetType: 'platform_admin',
    targetId: null,
    targetLabel: world.supportCandidate.email,
    reason: 'Joining the support rota',
    correlationId,
    afterJson: JSON.stringify({ preset: 'support' }),
    ip: '203.0.113.10',
    userAgent: 'Firefox/130',
    ...fields,
  };
}

function actorFor(userId: string, email: string): PlatformAdminActor {
  return {
    account: { userId, email, displayName: email, emailVerified: true, mfaEnabled: true },
    sessionId: uuidv7(),
    stepUp: null,
    source: 'env',
    preset: 'super_admin',
    permissions: [...PLATFORM_PERMISSIONS],
  };
}

const ctx = { correlationId, ip: '203.0.113.11', userAgent: 'Safari/18' };

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
  admins = new PlatformAdminsRepository(tenant);
  lookup = new PlatformAdminRepository(tenant);
});

afterAll(async () => {
  await db?.stop();
});

describe('platform_admins', () => {
  let adminId = '';

  it('starts empty: no team row means the feature rests on the server list alone', async () => {
    expect(await admins.anyActive(correlationId)).toBe(false);
    expect(await lookup.findPlatformAdmin(world.supportCandidate.id, correlationId)).toBeNull();
  });

  it('adds an admin with the audit row in the same transaction, 0239 columns filled', async () => {
    adminId = await admins.insert(
      {
        userId: world.supportCandidate.id,
        preset: 'support',
        customPermissions: null,
        createdBy: world.platformAdmin.id,
      },
      audit(),
    );
    const record = await lookup.findPlatformAdmin(world.supportCandidate.id, correlationId);
    expect(record).toMatchObject({ id: adminId, preset: 'support', status: 'active' });
    expect(record?.permissions).toEqual([...PLATFORM_PRESETS.support]);
    expect(await admins.anyActive(correlationId)).toBe(true);

    const [row] = await observe(
      `select action, target_id, reason, before_json, after_json, ip, user_agent
         from platform_admin_audit_events where correlation_id = ? order by created_at, id`,
      [correlationId],
    );
    expect(row).toMatchObject({
      action: 'platform.team_admin_added',
      target_id: adminId,
      reason: 'Joining the support rota',
      before_json: null,
      ip: '203.0.113.10',
      user_agent: 'Firefox/130',
    });
    expect(JSON.parse(String(row?.['after_json']))).toEqual({ preset: 'support' });
  });

  it('resolves a named preset against the stored mapping once a super admin rewrites it', async () => {
    await admins.writePreset(
      'support',
      ['platform.orgs.view', 'platform.activity.export'],
      audit({
        action: 'platform.team_preset_updated',
        targetType: 'platform_preset',
        reason: null,
      }),
    );
    const record = await admins.findForUser(world.supportCandidate.id, correlationId);
    expect(record?.permissions).toEqual(['platform.orgs.view', 'platform.activity.export']);
    const [stored] = await observe(
      `select permissions_json, updated_by from platform_permission_presets where preset = 'support'`,
    );
    expect(stored?.['updated_by']).toBe(world.platformAdmin.id);
    // A null reason is a real row now (0239 made the column nullable).
    const nullReason = await observe(
      `select count(*) as n from platform_admin_audit_events
        where action = 'platform.team_preset_updated' and reason is null`,
    );
    expect(Number(nullReason[0]?.['n'])).toBe(1);
  });

  it('stores a custom list without the super-admin-only key', async () => {
    await admins.update(
      adminId,
      {
        preset: 'custom',
        customPermissions: ['platform.people.view'],
        status: 'active',
        disabledReason: null,
      },
      audit({ action: 'platform.team_admin_updated', targetId: adminId }),
    );
    const record = await admins.findById(adminId, correlationId);
    expect(record).toMatchObject({
      preset: 'custom',
      customPermissions: ['platform.people.view'],
      permissions: ['platform.people.view'],
    });
  });

  it('disables in place — the row stays, the lookup sees it disabled, nobody active is left', async () => {
    await admins.update(
      adminId,
      {
        preset: 'custom',
        customPermissions: [],
        status: 'disabled',
        disabledReason: 'Left the team',
      },
      audit({ action: 'platform.team_admin_disabled', targetId: adminId }),
    );
    const [row] = await observe(
      'select status, disabled_at, disabled_reason from platform_admins where id = ?',
      [adminId],
    );
    expect(row?.['status']).toBe('disabled');
    expect(row?.['disabled_at']).toBeInstanceOf(Date);
    expect(row?.['disabled_reason']).toBe('Left the team');
    expect((await lookup.findPlatformAdmin(world.supportCandidate.id, correlationId))?.status).toBe(
      'disabled',
    );
    expect(await admins.anyActive(correlationId)).toBe(false);
  });

  it('lists the team joined to the account and the adder', async () => {
    const team = await admins.listTeam(correlationId);
    expect(team).toHaveLength(1);
    expect(team[0]).toMatchObject({
      email: world.supportCandidate.email,
      createdByEmail: world.platformAdmin.email,
      status: 'disabled',
    });
  });

  it('enforces the team rules over real rows', async () => {
    const service = new PlatformTeamService(admins, [world.platformAdmin.email]);
    const peter = actorFor(world.platformAdmin.id, world.platformAdmin.email);

    // The server-list admin is locked and cannot be added as a team row.
    await expect(
      service.add(
        peter,
        { email: world.platformAdmin.email, preset: 'support', reason: 'Trying the bootstrap' },
        ctx,
      ),
    ).rejects.toMatchObject({ status: 409 });

    // Enable the disabled admin as a super admin, then disable them: the server list keeps one.
    await service.update(
      peter,
      adminId,
      { preset: 'super_admin', status: 'active', reason: 'Back on the team' },
      ctx,
    );
    const view = await service.list(peter, ctx);
    expect(view.admins.map((a) => [a.email, a.source, a.locked, a.self])).toEqual([
      [world.platformAdmin.email, 'env', true, true],
      [world.supportCandidate.email, 'db', false, false],
    ]);
    expect(view.superAdmins).toBe(2);
    await service.remove(peter, adminId, { reason: 'Rota finished' }, ctx);
    const actions = await observe(
      `select action, ip, user_agent from platform_admin_audit_events
        where target_id = ? and correlation_id = ? and ip = ? order by created_at, id`,
      [adminId, correlationId, '203.0.113.11'],
    );
    expect(actions.map((a) => a['action'])).toEqual([
      'platform.team_admin_enabled',
      'platform.team_admin_removed',
    ]);
    expect(actions[0]?.['user_agent']).toBe('Safari/18');

    // The added admin cannot edit their own row, even holding team.manage.
    const karim = actorFor(world.supportCandidate.id, world.supportCandidate.email);
    await expect(
      service.update(karim, adminId, { status: 'active', reason: 'Reinstating myself' }, ctx),
    ).rejects.toMatchObject({ status: 409 });
  });
});
