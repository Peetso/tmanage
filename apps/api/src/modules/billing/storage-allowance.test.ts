import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { SubscriptionRow } from '../../common/database/schema.js';
import type { StorageMode } from '../google-drive/storage-mode.repository.js';
import { PLAN_FEATURE_SET, PLAN_IDS } from './plan-catalog.js';
import { allowanceOf, storageThreshold } from './storage-allowance.js';
import { NO_WORKSPACE_LIMIT, StorageAllowanceService } from './storage-allowance.service.js';

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
  it('lets the platform cap win over a plan figure', () => {
    expect(allowanceOf(25 * GB, null, 10 * GB)).toEqual({
      limitBytes: 10 * GB,
      raisedBySupport: false,
      hasFigure: true,
    });
  });

  it('lets a support raise win over the plan figure but never over the cap', () => {
    expect(allowanceOf(1 * GB, 3 * GB, 10 * GB)).toEqual({
      limitBytes: 3 * GB,
      raisedBySupport: true,
      hasFigure: true,
    });
    expect(allowanceOf(1 * GB, 40 * GB, 10 * GB).limitBytes).toBe(10 * GB);
  });

  it('falls back to the cap when the plan has no figure (Enterprise, by agreement)', () => {
    expect(allowanceOf(null, null, 10 * GB)).toMatchObject({
      limitBytes: 10 * GB,
      hasFigure: false,
    });
  });
});

describe('StorageAllowanceService.limitsFor', () => {
  function service(mode: StorageMode): StorageAllowanceService {
    const runner = {} as never;
    const database = {
      read: <T>(_c: TenantContext, work: (db: never) => Promise<T>): Promise<T> => work(runner),
    } as unknown as TenantDatabase;
    const tenant = (ctx: TenantContext) => expect(ctx.organizationId).toBe(ORG);
    return new StorageAllowanceService(
      database,
      60 * GB,
      {
        find: (_r, ctx) => (
          tenant(ctx),
          Promise.resolve({ planId: 'free', status: 'active' } as SubscriptionRow)
        ),
      },
      { findOverrideBytes: (_r, ctx) => (tenant(ctx), Promise.resolve(null)) },
      (_r, ctx) => (tenant(ctx), Promise.resolve(mode)),
    );
  }

  it('holds a TManage upload to the allowance, so a full allowance refuses the next byte', async () => {
    const limits = await service('tmanage').limitsFor(context);
    expect(limits).toEqual({ allowanceBytes: 1 * GB, uploadLimitBytes: 1 * GB });
    expect(1 * GB + 1 > limits.uploadLimitBytes).toBe(true);
  });

  it('passes a file through to Drive even with the platform cap already reached', async () => {
    const limits = await service('google_drive').limitsFor(context);
    expect(limits.uploadLimitBytes).toBe(NO_WORKSPACE_LIMIT);
    expect(limits.allowanceBytes).toBe(1 * GB);
    const heldAtCap = 60 * GB;
    expect(heldAtCap + 2 * GB <= limits.uploadLimitBytes).toBe(true);
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
