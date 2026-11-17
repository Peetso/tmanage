import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ensureRequestState } from '../../common/http/request-state.js';
import { TimesheetsController } from '../time/timesheets.controller.js';
import { FeatureGateGuard, featureRequirement } from './feature-gate.js';

/** A database whose flag read answers the stored rows; no platform tables. */
const databaseWith = (rows: { flagKey: string; enabled: boolean }[]) =>
  ({ read: async () => rows }) as unknown as TenantDatabase;

function execution(): ExecutionContext {
  const request = {};
  const state = ensureRequestState(request) as { tenant?: unknown };
  state.tenant = { organizationId: 'org-1', correlationId: 'c-1' };
  return {
    getHandler: () => function handler() {},
    getClass: () => TimesheetsController,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('52-24 RequireFeature gate', () => {
  it('flag off: the gated route is refused with the calm 404', async () => {
    const guard = new FeatureGateGuard(
      new Reflector(),
      databaseWith([{ flagKey: 'time_tracking', enabled: false }]),
    );
    await expect(guard.canActivate(execution())).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
  });

  it('public door: public_forms off refuses with the same 404 as an unknown form', async () => {
    const check = featureRequirement(databaseWith([{ flagKey: 'public_forms', enabled: false }]));
    const context = { organizationId: 'org-1', correlationId: 'c-1' } as TenantContext;
    await expect(check(context, 'public_forms')).rejects.toMatchObject({ status: 404 });
    await expect(check(context, 'quotes')).resolves.toBeUndefined();
  });

  it('flag on (the default): the route is allowed', async () => {
    const guard = new FeatureGateGuard(new Reflector(), databaseWith([]));
    await expect(guard.canActivate(execution())).resolves.toBe(true);
  });
});
