import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { uuidv7 } from '@tmanage/domain';
import { TenantDatabase } from '../src/common/database/tenant-context.js';
import { resolveFlags } from '../src/modules/admin/feature-flags.service.js';
import type { PlatformAdminActor } from '../src/modules/platform-admin/platform-admin.guard.js';
import { PlatformAdminRepository } from '../src/modules/platform-admin/platform-admin.repository.js';
import { PlatformFlagsRepository } from '../src/modules/platform-admin/settings/flags.repository.js';
import { PlatformFlagsService } from '../src/modules/platform-admin/settings/flags.service.js';
import { PlatformSettingsRepository } from '../src/modules/platform-admin/settings/settings.repository.js';
import { PlatformSettingsService } from '../src/modules/platform-admin/settings/settings.service.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';

/**
 * PLAT-016 against a real server — Platform settings and feature flags (PA-10, SPEC §4 D1–D2,
 * migration 0244).
 *
 * 1. Settings: the first read seeds the retention and support rows from code; a billing-mode
 *    change persists, wins over the environment default and writes its audit row in the same
 *    transaction, with the reason and the before/after.
 * 2. Flags: an allowlist rollout and a forced organization persist; the org-side read chain
 *    (`contextFor` + `resolveFlags`) turns `copilot` on for exactly the allowlisted organization
 *    and the forced one; removing the forced row (soft, `removed_at`) takes it back off.
 * 3. An unknown key is refused and writes nothing.
 */

let db: TestDatabase;
let tenant: TenantDatabase;
let world: SeedWorld;
let settings: PlatformSettingsService;
let flags: PlatformFlagsService;
let flagsRepository: PlatformFlagsRepository;

function context() {
  return { correlationId: uuidv7(), ip: '203.0.113.7', userAgent: 'vitest' };
}

function actor(): PlatformAdminActor {
  return {
    account: {
      userId: world.platformAdmin.id,
      email: world.platformAdmin.email,
      displayName: 'Platform',
      emailVerified: true,
      mfaEnabled: false,
    },
    sessionId: 'plat-016',
    stepUp: { expiresAt: new Date(Date.now() + 10 * 60_000), mfaVerified: false },
  };
}

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

async function copilotFor(organizationId: string): Promise<boolean> {
  const platform = await flagsRepository.contextFor(organizationId, uuidv7(), {});
  return resolveFlags([], platform).copilot;
}

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
  settings = new PlatformSettingsService(new PlatformAdminRepository(tenant), false, {
    store: new PlatformSettingsRepository(tenant),
    environment: { BILLING_MODE: 'beta_free' },
  });
  flagsRepository = new PlatformFlagsRepository(tenant);
  flags = new PlatformFlagsService(flagsRepository, {});
});

afterAll(async () => {
  await db?.stop();
});

describe('Platform settings (PLAT-016)', () => {
  it('seeds the retention and support rows on the first read', async () => {
    const view = await settings.fullSettings(context());
    expect(view.retention).toEqual({ orgPurgeDays: 30, userPurgeDays: 30, contentPurgeDays: 30 });
    expect(view.supportDefaults).toEqual({ maxMinutes: 480, requireReason: false });
    expect(view.billingMode.source).toBe('environment');
    expect(view.billingMode.organizationCount).toBeGreaterThanOrEqual(2);
    const seeded = await observe(
      `select setting_key from platform_settings
        where setting_key in ('retention.org_purge_days', 'support.max_minutes')`,
    );
    expect(seeded).toHaveLength(2);
  });

  it('persists a billing-mode change over the environment, with its audit row', async () => {
    const view = await settings.setBillingMode(
      actor(),
      { mode: 'paid', reason: 'Beta ends on 1 Dec 2026' },
      context(),
    );
    expect(view.billingMode).toMatchObject({ mode: 'paid', source: 'platform_setting' });
    expect(view.changes.billingMode.at).not.toBeNull();
    const [row] = await observe(
      `select setting_value from platform_settings where setting_key = 'billing_mode'`,
    );
    expect(row?.['setting_value']).toBe('paid');
    const [audit] = await observe(
      `select reason, before_json, after_json from platform_admin_audit_events
        where action = 'platform.billing_mode_changed' order by created_at desc, id desc limit 1`,
    );
    expect(audit?.['reason']).toBe('Beta ends on 1 Dec 2026');
    expect(String(audit?.['after_json'])).toContain('paid');

    await settings.setBillingMode(
      actor(),
      { mode: 'beta_free', reason: 'Back to beta' },
      context(),
    );
    expect((await settings.fullSettings(context())).billingMode.mode).toBe('beta_free');
  });

  it('refuses retention outside 1–365 and writes nothing', async () => {
    await expect(
      settings.setRetention(
        actor(),
        { orgPurgeDays: 0, userPurgeDays: 30, contentPurgeDays: 30 },
        context(),
      ),
    ).rejects.toMatchObject({ status: 400 });
    const [row] = await observe(
      `select setting_value from platform_settings where setting_key = 'retention.org_purge_days'`,
    );
    expect(row?.['setting_value']).toBe('30');
  });
});

describe('Feature flags (PLAT-016)', () => {
  it('turns copilot on for the allowlisted and the forced organization only', async () => {
    const northstar = world.northstar.organizationId;
    const twin = world.twin.organizationId;
    expect(await copilotFor(northstar)).toBe(false);

    await flags.update(
      actor(),
      'copilot',
      { enabled: true, rollout: 'allowlist', allowlistOrganizationIds: [northstar] },
      context(),
    );
    expect(await copilotFor(northstar)).toBe(true);
    expect(await copilotFor(twin)).toBe(false);

    await flags.update(
      actor(),
      'copilot',
      {
        enabled: true,
        rollout: 'allowlist',
        allowlistOrganizationIds: [northstar],
        overrides: [{ organizationId: twin, state: 'on' }],
        reason: 'Pilot for the twin',
      },
      context(),
    );
    expect(await copilotFor(twin)).toBe(true);
    const list = await flags.list(context());
    const copilot = list.flags.find((flag) => flag.key === 'copilot');
    expect(copilot).toMatchObject({ rollout: 'allowlist', forcedOn: 1 });
    expect(copilot?.usedByOrganizations).toBe(2);

    await flags.update(
      actor(),
      'copilot',
      {
        enabled: true,
        rollout: 'allowlist',
        allowlistOrganizationIds: [northstar],
        overrides: [{ organizationId: twin, state: 'none' }],
      },
      context(),
    );
    expect(await copilotFor(twin)).toBe(false);
    const [override] = await observe(
      `select removed_at from platform_org_flag_overrides where flag_key = 'copilot' and organization_id = ?`,
      [twin],
    );
    expect(override?.['removed_at']).not.toBeNull();
    const audits = await observe(
      `select count(*) as n from platform_admin_audit_events where action = 'platform.flag_updated'`,
    );
    expect(Number(audits[0]?.['n'])).toBe(3);

    // Back to the code default for the rest of the suite.
    await flags.update(actor(), 'copilot', { enabled: false, rollout: 'everyone' }, context());
  });

  it('refuses an unknown key and writes nothing', async () => {
    await expect(
      flags.update(actor(), 'ai_side_panel', { enabled: true, rollout: 'everyone' }, context()),
    ).rejects.toMatchObject({ status: 400 });
    const rows = await observe(
      `select count(*) as n from platform_feature_flags where flag_key = 'ai_side_panel'`,
    );
    expect(Number(rows[0]?.['n'])).toBe(0);
  });
});
