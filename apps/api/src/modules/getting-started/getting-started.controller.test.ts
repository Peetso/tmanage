import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { GettingStartedController } from './getting-started.controller.js';
import { type ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { GettingStartedRepository } from './getting-started.repository.js';
import type { ChecklistSignals, StoredChecklist } from './getting-started.steps.js';
import {
  parseStoredChecklist,
  projectSetupHealth,
  requiresTwoStep,
} from './getting-started.steps.js';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const context = { organizationId: ORG, membershipId: 'm1', userId: 'u1' } as TenantContext;

function principal(role: string): Principal {
  return {
    userId: 'u1',
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

const NONE: ChecklistSignals = {
  invite_teammate: false,
  create_project: false,
  add_client: false,
  connect_storage: false,
  set_working_hours: false,
  try_ai_assistant: false,
};

class FakeRepository {
  stored: StoredChecklist = { marked: [], dismissedAt: null };
  signals: ChecklistSignals = NONE;
  writes = 0;
  readStored = () => Promise.resolve(this.stored);
  writeStored = (_r: unknown, _c: unknown, _m: string, next: StoredChecklist) => {
    this.writes += 1;
    this.stored = next;
    return Promise.resolve();
  };
  readSignals = () => Promise.resolve(this.signals);
  readHealth = () =>
    Promise.resolve({
      storageConnected: true,
      twoStepRequired: false,
      recentExport: false,
      mailInActive: true,
    });
}

function controllerWith(repo: FakeRepository): GettingStartedController {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  return new GettingStartedController(database, repo as unknown as GettingStartedRepository);
}

describe('GettingStartedController (55-11 / 55-22)', () => {
  it('derives done steps from company data and points at the next unfinished one', async () => {
    const repo = new FakeRepository();
    repo.signals = { ...NONE, invite_teammate: true, create_project: true };
    const view = await controllerWith(repo).read(context, principal('member'));
    expect(view.completedCount).toBe(2);
    expect(view.nextStep).toBe('add_client');
    expect(view.dismissed).toBe(false);
  });

  it('marks a step by hand idempotently and 400s an unknown step with no write', async () => {
    const repo = new FakeRepository();
    const controller = controllerWith(repo);
    await controller.complete(context, principal('member'), 'try_ai_assistant');
    const again = await controller.complete(context, principal('member'), 'try_ai_assistant');
    expect(repo.writes).toBe(1);
    expect(again.steps.find((s) => s.step === 'try_ai_assistant')?.done).toBe(true);
    const error = await controller
      .complete(context, principal('member'), 'nope')
      .catch((e: unknown) => e);
    expect((error as ApiError).status).toBe(400);
    expect(repo.writes).toBe(1);
  });

  it('dismisses once and persists it for the member', async () => {
    const repo = new FakeRepository();
    const controller = controllerWith(repo);
    expect((await controller.dismiss(context, principal('member'))).dismissed).toBe(true);
    await controller.dismiss(context, principal('member'));
    expect(repo.writes).toBe(1);
    expect((await controller.read(context, principal('member'))).dismissed).toBe(true);
  });

  it('gives the owner Setup health and refuses a member', async () => {
    const controller = controllerWith(new FakeRepository());
    const view = await controller.health(context, principal('owner'));
    expect(view.okCount).toBe(2);
    expect(view.checks.map((c) => c.check)).toEqual([
      'storage',
      'sign_in_security',
      'backups',
      'domain_mail',
    ]);
    const error = await controller.health(context, principal('member')).catch((e: unknown) => e);
    expect((error as ApiError).status).toBe(403);
  });

  it('drops unknown stored steps and reads two-step scopes', () => {
    expect(parseStoredChecklist('{"marked":["add_client","x"],"dismissedAt":null}').marked).toEqual(
      ['add_client'],
    );
    expect(parseStoredChecklist('not json')).toEqual({ marked: [], dismissedAt: null });
    expect(requiresTwoStep('nobody')).toBe(false);
    expect(requiresTwoStep('admins')).toBe(true);
    expect(
      projectSetupHealth({
        storageConnected: false,
        twoStepRequired: false,
        recentExport: false,
        mailInActive: false,
      }).okCount,
    ).toBe(0);
  });
});
