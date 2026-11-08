import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { OnboardingWizardController } from './onboarding-wizard.controller.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { OrgSettingsRepository } from '../tenancy/org-settings.repository.js';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const context = { organizationId: ORG, membershipId: 'm1' } as unknown as TenantContext;

function principal(role: string): Principal {
  return {
    userId: '00000000-0000-4000-8000-0000000000c1',
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'm1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  } as Principal;
}

/** One stored settings value, as the real repository's findByKey/upsert see it. */
class FakeSettings {
  value: string | undefined;
  writes = 0;
  resolveOrganization = () => Promise.resolve({ id: ORG });
  findByKey = () =>
    Promise.resolve(this.value === undefined ? undefined : { settingValue: this.value });
  upsert = (_r: unknown, _c: unknown, input: { value: string }) => {
    this.writes += 1;
    this.value = input.value;
    return Promise.resolve();
  };
}

function controllerWith(settings: FakeSettings): OnboardingWizardController {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  return new OnboardingWizardController(database, settings as unknown as OrgSettingsRepository);
}

async function statusOf(promise: Promise<unknown>): Promise<number> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  return (error as ApiError).status;
}

describe('OnboardingWizardController (55-01)', () => {
  it('resumes from the stored row after a reload', async () => {
    const settings = new FakeSettings();
    await controllerWith(settings).record(context, principal('owner'), 'company', {
      outcome: 'done',
    });
    const view = await controllerWith(settings).read(context, principal('owner'));
    expect(view.currentStep).toBe('work_type');
    expect(view.steps[0]).toEqual({ step: 'company', outcome: 'done' });
  });

  it('400s an unknown step or outcome with no write, and refuses a member without org.manage', async () => {
    const settings = new FakeSettings();
    const controller = controllerWith(settings);
    expect(
      await statusOf(controller.record(context, principal('owner'), 'nope', { outcome: 'done' })),
    ).toBe(400);
    expect(
      await statusOf(controller.record(context, principal('owner'), 'invite', { outcome: 'x' })),
    ).toBe(400);
    expect(await statusOf(controller.read(context, principal('member')))).toBe(403);
    expect(settings.writes).toBe(0);
  });
});
