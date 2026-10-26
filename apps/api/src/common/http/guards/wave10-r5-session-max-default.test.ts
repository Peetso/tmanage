import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TenantContextGuard, createTenantGuardChecks } from './tenant-context.guard.js';
import { requireRequestState } from '../request-state.js';
import { createAiAccessSwitchesFrom } from '../../../modules/oauth/ai-access.js';
import { SearchController } from '../../../modules/search/search.controller.js';
import type { PoliciesRepository } from '../../../modules/admin/policies.repository.js';

/**
 * Wave 10 R5 — F52a (partial): with no `org_policies` row the policy screen shows the default
 * 24-hour session lifetime as "In force now", but the guard enforced nothing. The real
 * `createTenantGuardChecks` now applies the normalized default, so a 25-hour-old cookie session is
 * ended (401 `reauth_required`) on a tenant route, a 23-hour-old one passes, and an owner's saved
 * 48 hours lets the 25-hour-old session through.
 */

const USER = '0198f4a2-1c00-7000-8000-00000000000c';
const HOUR = 3_600_000;
const NOW = 1_000 * HOUR;

type Handler = (...args: never[]) => unknown;
const search = SearchController.prototype.run as Handler;

function harness(policy: unknown, sessionAgeHours: number) {
  const policies = {
    find: vi.fn(async () => (policy === undefined ? undefined : { policyJson: policy })),
  } as unknown as PoliciesRepository;
  const sessionRows = {
    findById: vi.fn(async () => ({
      session: { createdAt: new Date(NOW - sessionAgeHours * HOUR) },
    })),
  };
  const revoke = vi.fn(async () => true);
  const database = {
    read: vi.fn(async (_ctx: unknown, work: (runner: unknown) => Promise<unknown>) => work({})),
    identityRead: vi.fn(async (_o: unknown, work: (runner: unknown) => Promise<unknown>) =>
      work({}),
    ),
  } as never;
  const switches = createAiAccessSwitchesFrom({
    environmentDisabled: false,
    readPlatform: () => Promise.resolve(null),
    readOrganization: () => Promise.resolve(null),
  });
  const checks = createTenantGuardChecks(
    database,
    switches,
    { revoke },
    policies,
    sessionRows as never,
    () => NOW,
  );
  const resolver = {
    resolve: vi.fn(async () => ({
      context: { organizationId: 'org-a', userId: USER },
      role: 'member',
      clientOrganizationId: null,
      hasOrgWideScope: true,
      workspaceScopeId: null,
    })),
  } as never;
  const principals = { load: vi.fn(async () => ({ userId: USER })) } as never;
  const guard = new TenantContextGuard(new Reflector(), resolver, principals, database, checks);

  const request = { params: { orgSlug: 'northstar' }, headers: {} };
  const state = requireRequestState(request);
  state.session = { sessionId: 's1', userId: USER };
  state.authScheme = 'cookie';
  const execution = {
    getHandler: () => search,
    getClass: () => SearchController,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { run: () => guard.canActivate(execution), revoke };
}

describe('wave 10 R5 — F52a: the default session lifetime is enforced without a policy row', () => {
  it('ends a 25-hour-old cookie session when the company stored no policy (401 reauth_required)', async () => {
    const { run, revoke } = harness(undefined, 25);
    await expect(run()).rejects.toMatchObject({
      status: 401,
      auditCode: 'reauth_required:org_session_max_hours',
    });
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it('lets a 23-hour-old session through with no policy row', async () => {
    const { run, revoke } = harness(undefined, 23);
    await expect(run()).resolves.toBe(true);
    expect(revoke).not.toHaveBeenCalled();
  });

  it("honours the owner's saved 48 hours: the 25-hour-old session passes", async () => {
    const { run, revoke } = harness({ session_max_hours: 48 }, 25);
    await expect(run()).resolves.toBe(true);
    expect(revoke).not.toHaveBeenCalled();
  });
});
