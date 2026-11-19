import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { capabilitiesFor } from '@tmanage/domain';
import type { Principal, SignalRuleSetting, StoredSignalSetting } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { SignalSettingsController } from './signals.controller.js';
import type { SignalSettingsRepository } from './signals.repository.js';
import { SIGNAL_SETTINGS_AUDIT_ACTION, SignalSettingsService } from './signals.service.js';

/**
 * 62-27 (B05) — Settings → Alerts over fakes: owner only, money rules listed only with
 * `finance.view`, a bad save refused whole with no write, a good save upserted with the bound
 * clock and audited in the same transaction.
 */

const ORG = '0199aa00-0000-7000-8000-00000000000a';
const NOW = new Date('2026-11-19T10:00:00.000Z');

const contextWith = (capabilities = capabilitiesFor('owner')) =>
  ({ organizationId: ORG, userId: 'u-owner', capabilities }) as unknown as TenantContext;

function principal(role: Principal['role']): Principal {
  return {
    userId: 'u-owner',
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'm-owner',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

function build(stored: StoredSignalSetting[] = []) {
  const saves: { setting: SignalRuleSetting; at: Date }[] = [];
  const audits: unknown[] = [];
  const runner = {};
  const database = {
    read: async <T>(_c: TenantContext, work: (r: unknown) => Promise<T>) => work(runner),
    transaction: async <T>(_c: TenantContext, work: (r: unknown) => Promise<T>) => work(runner),
  } as unknown as TenantDatabase;
  const repository = {
    list: async () => stored,
    save: async (_r: unknown, _c: TenantContext, setting: SignalRuleSetting, at: Date) => {
      saves.push({ setting, at });
      stored = [...stored.filter((row) => row.rule !== setting.rule), setting];
    },
  } as unknown as SignalSettingsRepository;
  const audit = { record: async (_r: unknown, _c: unknown, input: unknown) => audits.push(input) };
  const service = new SignalSettingsService({
    database,
    audit: audit as never,
    repository,
    now: () => NOW,
  });
  return { service, saves, audits };
}

describe('SignalSettingsService', () => {
  it('the owner reads all eight rules with defaults, units, limits and choices', async () => {
    const { service } = build();
    const view = await service.read(contextWith(), principal('owner'));
    expect(view.rules.map((rule) => rule.rule)).toHaveLength(8);
    expect(view.rules.find((rule) => rule.rule === 'project_over_budget')).toEqual({
      rule: 'project_over_budget',
      enabled: true,
      threshold: 100,
      recipient: 'owner_and_finance_team',
      unit: 'percent_of_budget',
      min: 50,
      max: 300,
      recipients: ['owner_and_finance_team'],
      money: true,
    });
  });

  it('anyone but the owner is refused, admins included', async () => {
    const { service } = build();
    for (const role of ['org_admin', 'manager', 'member'] as const) {
      await expect(service.read(contextWith(), principal(role))).rejects.toMatchObject({
        status: 403,
      });
      await expect(service.update(contextWith(), principal(role), {})).rejects.toMatchObject({
        status: 403,
      });
    }
  });

  it('the finance rules are hidden without finance.view, and cannot be saved', async () => {
    const { service, saves } = build();
    const noFinance = contextWith(capabilitiesFor('owner').filter((c) => c !== 'finance.view'));
    const view = await service.read(noFinance, principal('owner'));
    expect(view.rules.map((rule) => rule.rule)).not.toContain('approved_time_not_invoiced');
    expect(view.rules.some((rule) => rule.money)).toBe(false);
    const body = {
      rules: [
        {
          rule: 'approved_time_not_invoiced',
          enabled: false,
          threshold: 14,
          recipient: 'finance_team',
        },
      ],
    };
    await expect(service.update(noFinance, principal('owner'), body)).rejects.toMatchObject({
      status: 400,
    });
    expect(saves).toEqual([]);
  });

  it('a bad save is a 400 with every issue and no write', async () => {
    const { service, saves, audits } = build();
    const body = {
      rules: [{ rule: 'stale_task', enabled: true, threshold: 0, recipient: 'nobody' }],
    };
    const error = (await service
      .update(contextWith(), principal('owner'), body)
      .catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(400);
    expect(saves).toEqual([]);
    expect(audits).toEqual([]);
  });

  it('a good save upserts each rule at the bound now, audits once, returns the new state', async () => {
    const { service, saves, audits } = build();
    const view = await service.update(contextWith(), principal('owner'), {
      rules: [
        { rule: 'stale_task', enabled: false, threshold: 30, recipient: 'their_manager' },
        { rule: 'overdue_invoice', enabled: true, threshold: 10, recipient: 'finance_team' },
      ],
    });
    expect(saves.map((save) => [save.setting.rule, save.at])).toEqual([
      ['stale_task', NOW],
      ['overdue_invoice', NOW],
    ]);
    expect(audits).toEqual([
      expect.objectContaining({
        action: SIGNAL_SETTINGS_AUDIT_ACTION,
        result: 'allowed',
        metadata: { rule_count: 2, rules: 'stale_task,overdue_invoice' },
      }),
    ]);
    expect(view.rules.find((rule) => rule.rule === 'stale_task')).toMatchObject({
      enabled: false,
      threshold: 30,
      recipient: 'their_manager',
    });
  });
});

describe('SignalSettingsController', () => {
  it('both routes need org.manage and sit behind the business_briefing flag', () => {
    const proto = SignalSettingsController.prototype;
    for (const handler of [proto.read, proto.update]) {
      expect(Reflect.getMetadata(REQUIRED_CAPABILITY, handler)).toBe('org.manage');
    }
    const keys = Reflect.getMetadataKeys(SignalSettingsController);
    const feature = keys
      .map((key) => Reflect.getMetadata(key, SignalSettingsController) as unknown)
      .find((value) => value === 'business_briefing');
    expect(feature).toBe('business_briefing');
  });
});
