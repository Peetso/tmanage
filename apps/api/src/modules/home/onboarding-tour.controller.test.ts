import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { OnboardingTourController } from './onboarding-tour.controller.js';
import type { OnboardingTourRepository } from './onboarding-tour.repository.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { OnboardingProgressRow, OnboardingTourStep } from '../../common/database/schema.js';

/**
 * ON-10 guided-tour progress (x155) over a fake repository.
 *
 * The database is faked, but the safety is not: an unknown step is rejected before any write (the
 * Known trap), a member advances only their own tour (own-principal), re-completing is idempotent (no
 * duplicate row), and the routes sit behind `work.read` (a caller without it is refused 403 by
 * `CapabilityGuard`, asserted through the route metadata the guard reads).
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const MY_MEMBERSHIP = '00000000-0000-4000-8000-0000000000e1';
const OTHER_MEMBERSHIP = '00000000-0000-4000-8000-0000000000e2';

function member(): Principal {
  return {
    userId: '00000000-0000-4000-8000-0000000000c1',
    organizationId: ORG,
    kind: 'internal',
    role: 'manager',
    membershipId: MY_MEMBERSHIP,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: false,
  };
}

const context = {
  organizationId: ORG,
  membershipId: MY_MEMBERSHIP,
} as unknown as TenantContext;

/** An in-memory {@link OnboardingTourRepository} mirroring the real one's idempotent completion. */
class FakeOnboardingTourRepository {
  readonly rows: OnboardingProgressRow[] = [];
  insertCalls = 0;
  private nextId = 1;

  findStep(
    _r: unknown,
    _c: unknown,
    membershipId: string,
    step: OnboardingTourStep,
  ): Promise<OnboardingProgressRow | undefined> {
    return Promise.resolve(
      this.rows.find((row) => row.membershipId === membershipId && row.step === step),
    );
  }

  async complete(
    _r: unknown,
    _c: unknown,
    membershipId: string,
    step: OnboardingTourStep,
  ): Promise<OnboardingProgressRow> {
    const existing = this.rows.find(
      (row) => row.membershipId === membershipId && row.step === step,
    );
    if (existing) return existing;
    this.insertCalls += 1;
    const row: OnboardingProgressRow = {
      id: `prog-${this.nextId++}`,
      organizationId: ORG,
      membershipId,
      step,
      completedAt: new Date('2026-09-21T00:00:00.000Z'),
    };
    this.rows.push(row);
    return row;
  }

  listForMembership(
    _r: unknown,
    _c: unknown,
    membershipId: string,
  ): Promise<OnboardingProgressRow[]> {
    return Promise.resolve(this.rows.filter((row) => row.membershipId === membershipId));
  }
}

function controllerWith(repo: FakeOnboardingTourRepository): OnboardingTourController {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  return new OnboardingTourController(database, repo as unknown as OnboardingTourRepository);
}

async function expectStatus<T>(promise: Promise<T>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

describe('OnboardingTourController (ON-10, x155)', () => {
  it('lists the fixed tour with all steps incomplete before any progress', async () => {
    const controller = controllerWith(new FakeOnboardingTourRepository());

    const view = await controller.list(context, member());

    expect(view.steps.length).toBeGreaterThan(0);
    expect(view.steps.every((s) => s.completed === false && s.completedAt === null)).toBe(true);
    expect(view.steps[0]?.step).toBe('welcome');
  });

  it('completes a step, then reports it complete on the next read (own-scoped round trip)', async () => {
    const repo = new FakeOnboardingTourRepository();
    const controller = controllerWith(repo);

    const after = await controller.complete(context, member(), 'create_project');
    const created = after.steps.find((s) => s.step === 'create_project');
    expect(created?.completed).toBe(true);
    expect(created?.completedAt).toBe('2026-09-21T00:00:00.000Z');

    const listed = await controller.list(context, member());
    expect(listed.steps.find((s) => s.step === 'create_project')?.completed).toBe(true);
    expect(listed.steps.filter((s) => s.completed)).toHaveLength(1);
  });

  it('400s an unknown step and writes nothing (Known trap)', async () => {
    const repo = new FakeOnboardingTourRepository();
    const controller = controllerWith(repo);

    await expectStatus(controller.complete(context, member(), 'not_a_step'), 400);
    expect(repo.insertCalls).toBe(0);
    expect(repo.rows).toHaveLength(0);
  });

  it('is idempotent — re-completing a step writes no duplicate row and answers with one completion', async () => {
    const repo = new FakeOnboardingTourRepository();
    const controller = controllerWith(repo);

    await controller.complete(context, member(), 'invite_team');
    const after = await controller.complete(context, member(), 'invite_team');

    expect(repo.insertCalls).toBe(1);
    expect(repo.rows).toHaveLength(1);
    expect(after.steps.filter((s) => s.completed)).toHaveLength(1);
  });

  it('never reflects another member’s progress (own-principal)', async () => {
    const repo = new FakeOnboardingTourRepository();
    repo.rows.push({
      id: 'prog-other',
      organizationId: ORG,
      membershipId: OTHER_MEMBERSHIP,
      step: 'welcome',
      completedAt: new Date('2026-09-20T00:00:00.000Z'),
    });
    const controller = controllerWith(repo);

    const mine = await controller.list(context, member());
    expect(mine.steps.every((s) => s.completed === false)).toBe(true);
  });

  it('guards every route with work.read, so a caller without it is refused 403 by CapabilityGuard', () => {
    for (const method of ['list', 'complete'] as const) {
      const capability = Reflect.getMetadata(
        REQUIRED_CAPABILITY,
        OnboardingTourController.prototype[method],
      );
      expect(capability).toBe('work.read');
    }
  });
});
