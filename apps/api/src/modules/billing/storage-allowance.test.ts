import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { SubscriptionRow } from '../../common/database/schema.js';
import type { StorageMode } from '../google-drive/storage-mode.repository.js';
import { PLAN_FEATURE_SET, PLAN_IDS } from './plan-catalog.js';
import {
  NO_WORKSPACE_LIMIT,
  STORAGE_FULL_MESSAGES,
  allowanceOf,
  plansCutByCeiling,
  storageFullMessage,
  storageThreshold,
} from './storage-allowance.js';
import { StorageAllowanceService } from './storage-allowance.service.js';

// 57-13r / 57-18 (plan 57 §19.1, §19.3): one assertion per key behaviour.

const GB = 1024 ** 3;
const ORG = 'org-under-test';
const context = { organizationId: ORG } as TenantContext;

beforeEach(() => {
  vi.stubEnv('BILLING_MODE', 'paid');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('storageThreshold', () => {
  it('reaches 70, 85, 95 and 100 % at the four steps, nothing below 70', () => {
    expect([69, 70, 84, 85, 95, 100, 130].map((used) => storageThreshold(used, 100))).toEqual([
      0, 70, 70, 85, 95, 100, 100,
    ]);
  });
});

describe('allowanceOf', () => {
  it('never refuses a plan with no set limit when no ceiling is set (the beta default)', () => {
    expect(allowanceOf(null, null, null)).toEqual({
      limitBytes: NO_WORKSPACE_LIMIT,
      limitedBy: null,
      raisedBySupport: false,
      hasFigure: false,
    });
  });

  it('lets a support raise win over the plan figure, and an explicit ceiling over both', () => {
    expect(allowanceOf(1 * GB, 3 * GB, null)).toMatchObject({
      limitBytes: 3 * GB,
      limitedBy: 'support',
      raisedBySupport: true,
    });
    expect(allowanceOf(1 * GB, 40 * GB, 10 * GB)).toMatchObject({
      limitBytes: 10 * GB,
      limitedBy: 'platform',
    });
  });

  it('still refuses at an explicit ceiling on a no-limit plan, and says it is the platform', () => {
    const allowance = allowanceOf(null, null, 10 * GB);
    expect(allowance).toMatchObject({
      limitBytes: 10 * GB,
      limitedBy: 'platform',
      hasFigure: true,
    });
    expect(storageFullMessage(allowance.limitedBy)).toBe(STORAGE_FULL_MESSAGES.platform);
    expect(storageFullMessage('plan')).toBe(STORAGE_FULL_MESSAGES.allowance);
  });

  it('names at boot only the plans an explicit ceiling cuts short', () => {
    const plans = { free: { storageBytes: 1 * GB }, enterprise: { storageBytes: null } };
    expect(plansCutByCeiling(null, plans)).toEqual([]);
    expect(plansCutByCeiling(5 * GB, plans)).toEqual(['enterprise']);
  });
});

describe('StorageAllowanceService.limitsFor', () => {
  function service(
    mode: StorageMode,
    planId: SubscriptionRow['planId'] = 'free',
    ceiling: number | null = null,
  ): StorageAllowanceService {
    const runner = {} as never;
    const database = {
      read: <T>(_c: TenantContext, work: (db: never) => Promise<T>): Promise<T> => work(runner),
    } as unknown as TenantDatabase;
    const tenant = (ctx: TenantContext) => expect(ctx.organizationId).toBe(ORG);
    return new StorageAllowanceService(
      database,
      ceiling,
      {
        find: (_r, ctx) => (
          tenant(ctx),
          Promise.resolve({ planId, status: 'active' } as SubscriptionRow)
        ),
      },
      { findOverrideBytes: (_r, ctx) => (tenant(ctx), Promise.resolve(null)) },
      (_r, ctx) => (tenant(ctx), Promise.resolve(mode)),
    );
  }

  it('holds a TManage upload to the plan allowance, so a full allowance refuses the next byte', async () => {
    const limits = await service('tmanage').limitsFor(context);
    expect(limits).toEqual({ allowanceBytes: 1 * GB, uploadLimitBytes: 1 * GB, limitedBy: 'plan' });
    expect(1 * GB + 1 > limits.uploadLimitBytes).toBe(true);
  });

  it('lets an Enterprise workspace past the old 1 GiB default when no ceiling is set', async () => {
    const limits = await service('tmanage', 'enterprise').limitsFor(context);
    expect(limits.limitedBy).toBeNull();
    expect(5 * GB <= limits.uploadLimitBytes).toBe(true);
  });

  it('never counts Drive-stored files, even with an explicit ceiling already reached', async () => {
    const limits = await service('google_drive', 'free', 60 * GB).limitsFor(context);
    expect(limits).toMatchObject({ uploadLimitBytes: NO_WORKSPACE_LIMIT, limitedBy: null });
    expect(limits.allowanceBytes).toBe(1 * GB);
    expect(60 * GB + 2 * GB <= limits.uploadLimitBytes).toBe(true);
  });
});

describe('57-18 every-plan controls', () => {
  it('gives security controls and the admin audit (export, custom roles) to every plan', () => {
    for (const plan of PLAN_IDS) {
      expect(PLAN_FEATURE_SET[plan]).toEqual(
        expect.arrayContaining(['security_controls', 'admin_audit']),
      );
    }
  });
});
