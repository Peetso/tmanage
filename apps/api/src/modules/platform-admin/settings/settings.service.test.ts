import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../common/http/errors.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import type { PlatformAdminRepository, PlatformAuditInput } from '../platform-admin.repository.js';
import type { PlatformSettingsRepository, StoredSetting } from './settings.repository.js';
import {
  BILLING_MODE_SETTING,
  PlatformSettingsService,
  RETENTION_CONTENT_SETTING,
  SEEDED_SETTINGS,
  buildFullView,
} from './settings.service.js';

/** PA-10 · D1: env default vs stored value, reasons, bounds. */

const ctx = { correlationId: 'c', ip: '203.0.113.9', userAgent: 'Firefox' };
const actor: PlatformAdminActor = {
  account: {
    userId: 'u',
    email: 'peter@example.com',
    displayName: 'Peter',
    emailVerified: true,
    mfaEnabled: true,
  },
  sessionId: 's',
  stepUp: null,
};

function stored(value: string, at = '2026-10-21T18:42:00Z'): StoredSetting {
  return { value, updatedAt: new Date(at), updatedBy: 'Peter' };
}

function harness(rows: Map<string, StoredSetting> = new Map(), env: NodeJS.ProcessEnv = {}) {
  const writes: { entries: ReadonlyArray<readonly [string, string]>; audit: PlatformAuditInput }[] =
    [];
  const store = {
    seed: vi.fn(async () => undefined),
    readAll: vi.fn(async () => rows),
    organizationCounts: vi.fn(async () => ({ total: 124, billingOverrides: 4 })),
    integrationCounts: vi.fn(async () => ({
      storage: {},
      calendar: {},
      grants: { connected: 0, lastSuccessAt: null, lastErrorAt: null, lastErrorCode: null },
    })),
    writeMany: vi.fn(async (entries: ReadonlyArray<readonly [string, string]>, audit) => {
      writes.push({ entries, audit });
      for (const [key, value] of entries) rows.set(key, stored(value));
    }),
  } as unknown as PlatformSettingsRepository;
  const repository = {
    readSetting: vi.fn(async () => null),
    writeSetting: vi.fn(async () => undefined),
  } as unknown as PlatformAdminRepository;
  const service = new PlatformSettingsService(repository, true, { store, environment: env });
  return { service, store, writes };
}

describe('buildFullView — env default vs stored value', () => {
  it('follows the environment with source "environment" when nothing is stored', () => {
    const view = buildFullView(new Map(), { total: 3, billingOverrides: null }, false, {
      BILLING_MODE: 'paid',
    });
    expect(view.billingMode).toMatchObject({
      mode: 'paid',
      source: 'environment',
      environmentDefault: 'paid',
      organizationCount: 3,
      overrideCount: null,
    });
    expect(view.publicSignup).toEqual({
      open: false,
      source: 'environment',
      environmentDefault: false,
    });
    expect(view.retention).toEqual({ orgPurgeDays: 30, userPurgeDays: 30, contentPurgeDays: 30 });
    expect(view.supportDefaults).toEqual({ maxMinutes: 480, requireReason: false });
    expect(view.stepUpMinutes).toBe(15);
    expect(view.changes.billingMode).toEqual({ at: null, by: null });
  });

  it('a stored value overrides the environment, with source "platform_setting" and who/when', () => {
    const rows = new Map([
      [BILLING_MODE_SETTING, stored('paid')],
      [RETENTION_CONTENT_SETTING, stored('90')],
    ]);
    const view = buildFullView(rows, { total: 1, billingOverrides: 0 }, true, {});
    expect(view.billingMode.mode).toBe('paid');
    expect(view.billingMode.source).toBe('platform_setting');
    expect(view.billingMode.environmentDefault).toBe('beta_free');
    expect(view.retention.contentPurgeDays).toBe(90);
    expect(view.changes.billingMode).toEqual({ at: '2026-10-21T18:42:00.000Z', by: 'Peter' });
  });

  it('TMANAGE_MCP_DISABLED forces AI access off whatever is stored', () => {
    const rows = new Map([['ai_access', stored('on')]]);
    const view = buildFullView(rows, { total: 0, billingOverrides: null }, true, {
      TMANAGE_MCP_DISABLED: '1',
    });
    expect(view.aiAccess).toEqual({ on: false, environmentDisabled: true });
  });
});

describe('PlatformSettingsService writes', () => {
  it('seeds the retention and support rows from code on first read', async () => {
    const { service, store } = harness();
    await service.fullSettings(ctx);
    expect(store.seed).toHaveBeenCalledWith(SEEDED_SETTINGS, 'c');
  });

  it('billing mode needs a reason (400, nothing written)', async () => {
    const { service, store } = harness();
    await expect(service.setBillingMode(actor, { mode: 'paid' }, ctx)).rejects.toMatchObject({
      status: 400,
    });
    expect(store.writeMany).not.toHaveBeenCalled();
  });

  it('billing mode writes the row and the audit row with before/after', async () => {
    const { service, writes } = harness();
    const view = await service.setBillingMode(
      actor,
      { mode: 'paid', reason: 'Beta ends on 1 Dec 2026' },
      ctx,
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]?.entries).toEqual([['billing_mode', 'paid']]);
    expect(writes[0]?.audit).toMatchObject({
      action: 'platform.billing_mode_changed',
      reason: 'Beta ends on 1 Dec 2026',
      beforeJson: JSON.stringify({ mode: 'beta_free' }),
      afterJson: JSON.stringify({ mode: 'paid' }),
    });
    expect(view.billingMode.mode).toBe('paid');
  });

  it('refuses an unknown billing mode', async () => {
    const { service } = harness();
    await expect(
      service.setBillingMode(actor, { mode: 'free', reason: 'Some reason' }, ctx),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it.each([0, 366, 1.5, '30'])('retention refuses %s days (bounds 1–365)', async (days) => {
    const { service, store } = harness();
    await expect(
      service.setRetention(
        actor,
        { orgPurgeDays: days, userPurgeDays: 30, contentPurgeDays: 30 },
        ctx,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(store.writeMany).not.toHaveBeenCalled();
  });

  it('retention accepts 1 and 365 without a reason', async () => {
    const { service, writes } = harness();
    const view = await service.setRetention(
      actor,
      { orgPurgeDays: 1, userPurgeDays: 365, contentPurgeDays: 30 },
      ctx,
    );
    expect(writes[0]?.audit.reason).toBeNull();
    expect(view.retention).toEqual({ orgPurgeDays: 1, userPurgeDays: 365, contentPurgeDays: 30 });
  });

  it('support defaults: at most 480 minutes, requireReason a boolean', async () => {
    const { service } = harness();
    await expect(
      service.setSupportDefaults(actor, { maxMinutes: 481, requireReason: false }, ctx),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.setSupportDefaults(actor, { maxMinutes: 120, requireReason: 'yes' }, ctx),
    ).rejects.toMatchObject({ status: 400 });
    const view = await service.setSupportDefaults(
      actor,
      { maxMinutes: 120, requireReason: true },
      ctx,
    );
    expect(view.supportDefaults).toEqual({ maxMinutes: 120, requireReason: true });
  });

  it('beta banner: English text is required while on', async () => {
    const { service } = harness();
    await expect(
      service.setBetaBanner(actor, { on: true, textEn: '', textAr: '' }, ctx),
    ).rejects.toMatchObject({ status: 400 });
    const view = await service.setBetaBanner(
      actor,
      { on: true, textEn: 'TManage is in free beta', textAr: '‏في مرحلة تجريبية' },
      ctx,
    );
    expect(view.betaBanner.on).toBe(true);
    expect(view.betaBanner.textEn).toBe('TManage is in free beta');
  });
});
