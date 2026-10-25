import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { SKIPS_TENANT } from '../decorators.js';
import { requireRequestState } from '../request-state.js';
import { isTwoStepExemptPath, TwoStepRequirementGuard } from './two-step-requirement.guard.js';
import { OrgSettingsController } from '../../../modules/tenancy/org-settings.controller.js';
import type { OrgSettingsRepository } from '../../../modules/tenancy/org-settings.repository.js';
import type { TenantContext, TenantDatabase } from '../../database/tenant-context.js';

/**
 * A11 — "Everyone must use two-step sign-in", enforced on tenant routes, with the enrolment and
 * own-profile routes left open and the settings route refusing to lock its own writer out.
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const USER = '00000000-0000-4000-8000-0000000000c1';
const CONTEXT = { organizationId: ORG, userId: USER, correlationId: 'c-1' } as TenantContext;

function fakes(input: { required: boolean; enrolled: boolean }) {
  const settings = {
    findByKey: vi.fn(async () =>
      input.required ? { settingKey: 'require_two_step', settingValue: 'true' } : undefined,
    ),
  };
  const identityRead = vi.fn(async () => input.enrolled);
  const database = {
    read: async (_c: unknown, work: (runner: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
    identityRead,
  } as unknown as TenantDatabase;
  return { settings, identityRead, database };
}

function guardFor(input: { required: boolean; enrolled: boolean; noTenant?: boolean }) {
  const { settings, identityRead, database } = fakes(input);
  const reflector = {
    getAllAndOverride: (key: symbol) => (key === SKIPS_TENANT ? (input.noTenant ?? false) : false),
  } as never;
  const guard = new TwoStepRequirementGuard(
    reflector,
    database,
    settings as unknown as OrgSettingsRepository,
  );
  return { guard, settings, identityRead };
}

function requestTo(url: string): { url: string; params: Record<string, string> } {
  const request = { url, params: { orgSlug: 'harbour' } };
  const state = requireRequestState(request);
  state.session = { sessionId: 's-1', userId: USER };
  state.tenant = CONTEXT;
  return request;
}

function executionFor(request: unknown): ExecutionContext {
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('TwoStepRequirementGuard', () => {
  it('refuses a tenant route with 403 two_step_required when the company requires it and the person has no factor', async () => {
    const { guard } = guardFor({ required: true, enrolled: false });
    await expect(
      guard.canActivate(executionFor(requestTo('/v1/organizations/harbour/projects'))),
    ).rejects.toMatchObject({
      status: 403,
      code: 'two_step_required',
      auditCode: 'org_policy:require_two_step',
    });
  });

  it('lets an enrolled person through', async () => {
    const { guard } = guardFor({ required: true, enrolled: true });
    await expect(
      guard.canActivate(executionFor(requestTo('/v1/organizations/harbour/projects'))),
    ).resolves.toBe(true);
  });

  it('changes nothing when the company does not require it, and never reads factors', async () => {
    const { guard, identityRead } = guardFor({ required: false, enrolled: false });
    await expect(
      guard.canActivate(executionFor(requestTo('/v1/organizations/harbour/projects'))),
    ).resolves.toBe(true);
    expect(identityRead).not.toHaveBeenCalled();
  });

  it('keeps the own profile and preferences routes open before enrolment', async () => {
    const { guard, settings } = guardFor({ required: true, enrolled: false });
    await expect(
      guard.canActivate(executionFor(requestTo('/v1/organizations/harbour/me/profile'))),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(executionFor(requestTo('/v1/organizations/harbour/me/preferences?x=1'))),
    ).resolves.toBe(true);
    expect(settings.findByKey).not.toHaveBeenCalled();
  });

  it('does not run on @NoTenant routes (enrolment, sign-out, factors)', async () => {
    const { guard, settings } = guardFor({ required: true, enrolled: false, noTenant: true });
    await expect(guard.canActivate(executionFor({ url: '/v1/auth/factors/totp' }))).resolves.toBe(
      true,
    );
    expect(settings.findByKey).not.toHaveBeenCalled();
  });

  it('does not exempt a path that only names an exempt route in its query string', () => {
    expect(isTwoStepExemptPath('/v1/organizations/harbour/me/profile')).toBe(true);
    expect(
      isTwoStepExemptPath('/v1/organizations/harbour/projects?next=/v1/organizations/h/me/profile'),
    ).toBe(false);
    expect(isTwoStepExemptPath('/v1/organizations/harbour/me/profile-photos')).toBe(false);
    expect(isTwoStepExemptPath(undefined)).toBe(false);
  });
});

describe('OrgSettingsController — no self lock-out on require_two_step', () => {
  const owner: Principal = {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role: 'owner',
    membershipId: '00000000-0000-4000-8000-0000000000e1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };

  function controllerFor(enrolled: boolean) {
    const { database } = fakes({ required: false, enrolled });
    const repo = {
      resolveOrganization: async () => ({ id: ORG }),
      listAll: async () => [],
      upsert: vi.fn(async () => undefined),
    };
    const controller = new OrgSettingsController(
      database,
      repo as unknown as OrgSettingsRepository,
    );
    return { controller, repo };
  }

  it('refuses to turn it on (409, no write) for someone not enrolled themselves', async () => {
    const { controller, repo } = controllerFor(false);
    await expect(
      controller.set(CONTEXT, owner, 'require_two_step', { value: true }),
    ).rejects.toMatchObject({ status: 409, code: 'conflict' });
    expect(repo.upsert).not.toHaveBeenCalled();
  });

  it('turns it on for an enrolled owner, and always lets it be turned off', async () => {
    const enrolled = controllerFor(true);
    await enrolled.controller.set(CONTEXT, owner, 'require_two_step', { value: true });
    expect(enrolled.repo.upsert).toHaveBeenCalledTimes(1);

    const notEnrolled = controllerFor(false);
    await notEnrolled.controller.set(CONTEXT, owner, 'require_two_step', { value: false });
    expect(notEnrolled.repo.upsert).toHaveBeenCalledTimes(1);
  });
});
