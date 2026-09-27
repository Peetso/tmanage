import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { InboxSnoozeController } from './inbox-snooze.controller.js';
import { InboxSnoozeService } from './inbox-snooze.service.js';
import type { InboxSnoozeRepository, SnoozeObjectType } from './inbox-snooze.repository.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { InboxSnoozeRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * IN-01/IN-02 (x259) snooze/list/un-snooze over fakes, with the **real** `authorize`. The database is
 * faked, the policy is not: a real `Principal` runs through the real evaluator, so these cases prove
 * the two rules that are the whole of this slice's safety — the bundle is resolved tenant-scoped
 * BEFORE the relation check (an unknown/cross-tenant/unreachable bundle is a 404 with no write), and a
 * past/invalid `until` is a 400 with no upsert (the required refusal) — and that the routes sit
 * behind `work.read` (asserted through the route metadata `CapabilityGuard` reads).
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const PROJECT = '00000000-0000-4000-8000-0000000000b1';
const MY_MEMBERSHIP = '00000000-0000-4000-8000-0000000000e1';
const WORK_ITEM = '00000000-0000-4000-8000-0000000000d1';
const BUNDLE = `work_item:${WORK_ITEM}`;
const FUTURE = '2099-01-01T00:00:00.000Z';
const PAST = '2000-01-01T00:00:00.000Z';

/** A manager who is a member of PROJECT: holds `work.read` and the project relation. */
function manager(): Principal {
  return {
    userId: '00000000-0000-4000-8000-0000000000c1',
    organizationId: ORG,
    kind: 'internal',
    role: 'manager',
    membershipId: MY_MEMBERSHIP,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [PROJECT],
    hasOrgWideScope: false,
  };
}

const context = { organizationId: ORG, membershipId: MY_MEMBERSHIP } as unknown as TenantContext;

/** An in-memory repository: an id is "unknown" simply by leaving it out of `knownBundles`. */
class FakeRepo {
  readonly rows: InboxSnoozeRow[] = [];
  upsertCalls = 0;
  deleteCalls = 0;

  constructor(private readonly knownBundles: ReadonlyMap<string, string>) {}

  resolveBundle(
    _r: unknown,
    _c: unknown,
    kind: SnoozeObjectType,
    objectId: string,
  ): Promise<{ readonly projectId: string } | undefined> {
    const projectId = this.knownBundles.get(`${kind}:${objectId}`);
    return Promise.resolve(projectId ? { projectId } : undefined);
  }

  upsert(
    _r: unknown,
    _c: unknown,
    membershipId: string,
    bundleId: string,
    snoozedUntil: Date,
  ): Promise<void> {
    this.upsertCalls += 1;
    const existing = this.rows.find(
      (row) => row.membershipId === membershipId && row.bundleId === bundleId,
    );
    if (existing) (existing as { snoozedUntil: Date }).snoozedUntil = snoozedUntil;
    else
      this.rows.push({
        id: `snz-${this.rows.length + 1}`,
        organizationId: ORG,
        membershipId,
        bundleId,
        snoozedUntil,
        createdAt: new Date('2026-09-27T00:00:00.000Z'),
        updatedAt: new Date('2026-09-27T00:00:00.000Z'),
      });
    return Promise.resolve();
  }

  deleteOwn(_r: unknown, _c: unknown, membershipId: string, bundleId: string): Promise<boolean> {
    this.deleteCalls += 1;
    const index = this.rows.findIndex(
      (row) => row.membershipId === membershipId && row.bundleId === bundleId,
    );
    if (index === -1) return Promise.resolve(false);
    this.rows.splice(index, 1);
    return Promise.resolve(true);
  }

  listForMembership(_r: unknown, _c: unknown, membershipId: string): Promise<InboxSnoozeRow[]> {
    return Promise.resolve(this.rows.filter((row) => row.membershipId === membershipId));
  }
}

function controllerWith(repo: FakeRepo): InboxSnoozeController {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const service = new InboxSnoozeService(database, repo as unknown as InboxSnoozeRepository);
  return new InboxSnoozeController(service);
}

const world = (): FakeRepo => new FakeRepo(new Map([[BUNDLE, PROJECT]]));

async function expectStatus<T>(promise: Promise<T>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

describe('InboxSnoozeController (IN-01/IN-02, x259)', () => {
  it('snoozes, lists, and un-snoozes — the own-scoped round trip', async () => {
    const repo = world();
    const controller = controllerWith(repo);

    const afterSnooze = await controller.snooze(context, manager(), BUNDLE, { until: FUTURE });
    expect(afterSnooze.snoozes).toEqual([
      { bundleId: BUNDLE, snoozedUntil: FUTURE, createdAt: '2026-09-27T00:00:00.000Z' },
    ]);

    expect((await controller.list(context, manager())).snoozes).toHaveLength(1);

    const afterUnsnooze = await controller.unsnooze(context, manager(), BUNDLE);
    expect(afterUnsnooze.snoozes).toEqual([]);
  });

  it('400s a past/invalid `until` and does not upsert (the refusal)', async () => {
    const repo = world();
    const controller = controllerWith(repo);

    await expectStatus(controller.snooze(context, manager(), BUNDLE, { until: PAST }), 400);
    await expectStatus(controller.snooze(context, manager(), BUNDLE, { until: 'not-a-date' }), 400);
    await expectStatus(controller.snooze(context, manager(), BUNDLE, {}), 400);
    expect(repo.upsertCalls).toBe(0);
    expect(repo.rows).toHaveLength(0);
  });

  it('404s and does not write when the bundle is unknown/cross-tenant (before authorize)', async () => {
    const repo = world();
    const controller = controllerWith(repo);

    await expectStatus(
      controller.snooze(context, manager(), 'work_item:00000000-0000-4000-8000-0000000000ff', {
        until: FUTURE,
      }),
      404,
    );
    // A malformed bundle id is a 404 too, never a 500.
    await expectStatus(controller.snooze(context, manager(), 'garbage', { until: FUTURE }), 404);
    expect(repo.upsertCalls).toBe(0);
  });

  it('404s a bundle whose project the caller cannot read, before any write (relation gate)', async () => {
    const repo = world();
    const controller = controllerWith(repo);
    const stranger: Principal = { ...manager(), projectIds: [] };

    await expectStatus(controller.snooze(context, stranger, BUNDLE, { until: FUTURE }), 404);
    expect(repo.upsertCalls).toBe(0);
  });

  it('guards every route with work.read (the capability CapabilityGuard reads)', () => {
    for (const method of ['list', 'snooze', 'unsnooze'] as const) {
      expect(
        Reflect.getMetadata(REQUIRED_CAPABILITY, InboxSnoozeController.prototype[method]),
      ).toBe('work.read');
    }
  });
});
