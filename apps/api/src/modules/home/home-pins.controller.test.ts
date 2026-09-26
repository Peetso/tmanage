import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { HomePinsController } from './home-pins.controller.js';
import type { HomePinsRepository } from './home-pins.repository.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { HomePinnedItemRow, HomePinTargetKind } from '../../common/database/schema.js';

/**
 * HOME-05 follow-up (x144) pin/list/unpin over fakes, with the **real** `authorize`.
 *
 * The database is faked, but the policy is not: a real `Principal` runs through the real evaluator,
 * so these cases prove the rules that are the whole of this slice's safety — the target is resolved
 * tenant-scoped BEFORE the relation check (an unknown or cross-tenant id is a 404 with no write, the
 * Known trap), a pin is private to its membership (an off-member unpin is a 404 removing nothing), a
 * duplicate is a 409, and the routes sit behind `work.read` (a caller without it is refused 403 by
 * `CapabilityGuard`, asserted through the route metadata the guard reads).
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const PROJECT = '00000000-0000-4000-8000-0000000000b1';
const MY_MEMBERSHIP = '00000000-0000-4000-8000-0000000000e1';
const OTHER_MEMBERSHIP = '00000000-0000-4000-8000-0000000000e2';
const WORK_ITEM = '00000000-0000-4000-8000-0000000000d1';

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

const context = {
  organizationId: ORG,
  membershipId: MY_MEMBERSHIP,
} as unknown as TenantContext;

/**
 * An in-memory {@link HomePinsRepository} with a configurable set of resolvable targets, so a test
 * makes an id "unknown" simply by leaving it out — exactly what a cross-tenant id looks like to the
 * real repository's tenant-scoped resolve.
 */
class FakeHomePinsRepository {
  readonly rows: HomePinnedItemRow[] = [];
  insertCalls = 0;
  private nextId = 1;

  constructor(private readonly knownTargets: ReadonlyMap<string, string>) {}

  static key(kind: HomePinTargetKind, targetId: string): string {
    return `${kind}:${targetId}`;
  }

  resolveTarget(
    _r: unknown,
    _c: unknown,
    kind: HomePinTargetKind,
    targetId: string,
  ): Promise<{ readonly projectId: string } | undefined> {
    const projectId = this.knownTargets.get(FakeHomePinsRepository.key(kind, targetId));
    return Promise.resolve(projectId ? { projectId } : undefined);
  }

  findPin(
    _r: unknown,
    _c: unknown,
    membershipId: string,
    kind: HomePinTargetKind,
    targetId: string,
  ): Promise<HomePinnedItemRow | undefined> {
    return Promise.resolve(
      this.rows.find(
        (row) =>
          row.membershipId === membershipId &&
          row.targetKind === kind &&
          row.targetId === targetId,
      ),
    );
  }

  insert(
    _r: unknown,
    _c: unknown,
    input: { membershipId: string; targetKind: HomePinTargetKind; targetId: string },
  ): Promise<HomePinnedItemRow> {
    this.insertCalls += 1;
    const row: HomePinnedItemRow = {
      id: `pin-${this.nextId++}`,
      organizationId: ORG,
      membershipId: input.membershipId,
      targetKind: input.targetKind,
      targetId: input.targetId,
      createdAt: new Date('2026-09-21T00:00:00.000Z'),
    };
    this.rows.push(row);
    return Promise.resolve(row);
  }

  deleteOwn(_r: unknown, _c: unknown, membershipId: string, id: string): Promise<boolean> {
    const index = this.rows.findIndex((row) => row.membershipId === membershipId && row.id === id);
    if (index === -1) return Promise.resolve(false);
    this.rows.splice(index, 1);
    return Promise.resolve(true);
  }

  listForMembership(_r: unknown, _c: unknown, membershipId: string): Promise<HomePinnedItemRow[]> {
    return Promise.resolve(
      this.rows
        .filter((row) => row.membershipId === membershipId)
        .sort(
          (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id),
        ),
    );
  }
}

function controllerWith(repo: FakeHomePinsRepository): HomePinsController {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  return new HomePinsController(database, repo as unknown as HomePinsRepository);
}

function fullWorld(): FakeHomePinsRepository {
  return new FakeHomePinsRepository(
    new Map([[FakeHomePinsRepository.key('work', WORK_ITEM), PROJECT]]),
  );
}

async function expectStatus<T>(promise: Promise<T>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

describe('HomePinsController (HOME-05 follow-up, x144)', () => {
  it('pins, lists newest-first, and unpins — the own-scoped round trip', async () => {
    const repo = fullWorld();
    const controller = controllerWith(repo);

    const afterPin = await controller.create(context, manager(), {
      targetKind: 'work',
      targetId: WORK_ITEM,
    });
    expect(afterPin).toEqual({
      pins: [
        {
          id: 'pin-1',
          targetKind: 'work',
          targetId: WORK_ITEM,
          createdAt: '2026-09-21T00:00:00.000Z',
        },
      ],
    });

    const listed = await controller.list(context, manager());
    expect(listed.pins).toHaveLength(1);

    const afterUnpin = await controller.remove(context, manager(), 'pin-1');
    expect(afterUnpin).toEqual({ pins: [] });
  });

  it('409s a duplicate pin, without a second row', async () => {
    const repo = fullWorld();
    const controller = controllerWith(repo);
    const body = { targetKind: 'work', targetId: WORK_ITEM } as const;

    await controller.create(context, manager(), body);
    await expectStatus(controller.create(context, manager(), body), 409);

    expect(repo.insertCalls).toBe(1);
    expect(repo.rows).toHaveLength(1);
  });

  it('404s and does not write when the target id is unknown/cross-tenant (Known trap)', async () => {
    const repo = fullWorld();
    const controller = controllerWith(repo);

    await expectStatus(
      controller.create(context, manager(), {
        targetKind: 'work',
        targetId: '00000000-0000-4000-8000-0000000000ff',
      }),
      404,
    );
    expect(repo.insertCalls).toBe(0);
    expect(repo.rows).toHaveLength(0);
  });

  it('404s a pin whose project the caller cannot read, before any write (relation gate)', async () => {
    const repo = fullWorld();
    const controller = controllerWith(repo);
    // A manager who is a member of no project: the target resolves, but the relation is denied.
    const stranger: Principal = { ...manager(), projectIds: [] };

    await expectStatus(
      controller.create(context, stranger, { targetKind: 'work', targetId: WORK_ITEM }),
      404,
    );
    expect(repo.insertCalls).toBe(0);
  });

  it('400s an unknown target kind', async () => {
    const repo = fullWorld();
    const controller = controllerWith(repo);

    await expectStatus(
      controller.create(context, manager(), { targetKind: 'meeting', targetId: WORK_ITEM }),
      400,
    );
    expect(repo.insertCalls).toBe(0);
  });

  it('denies unpinning another member’s pin (own-membership), removing nothing', async () => {
    const repo = fullWorld();
    const controller = controllerWith(repo);
    repo.rows.push({
      id: 'pin-other',
      organizationId: ORG,
      membershipId: OTHER_MEMBERSHIP,
      targetKind: 'work',
      targetId: WORK_ITEM,
      createdAt: new Date('2026-09-20T00:00:00.000Z'),
    });

    await expectStatus(controller.remove(context, manager(), 'pin-other'), 404);
    expect(repo.rows).toHaveLength(1);
  });

  it('never lists another member’s pins', async () => {
    const repo = fullWorld();
    const controller = controllerWith(repo);
    repo.rows.push({
      id: 'pin-other',
      organizationId: ORG,
      membershipId: OTHER_MEMBERSHIP,
      targetKind: 'work',
      targetId: WORK_ITEM,
      createdAt: new Date('2026-09-20T00:00:00.000Z'),
    });

    const mine = await controller.list(context, manager());
    expect(mine).toEqual({ pins: [] });
  });

  it('guards every route with work.read, so a caller without it is refused 403 by CapabilityGuard', () => {
    // The gate is metadata the guard reads (403 on a missing capability); asserting it here proves
    // the "no work.read → 403" rule without standing up the HTTP guard.
    for (const method of ['list', 'create', 'remove'] as const) {
      const capability = Reflect.getMetadata(
        REQUIRED_CAPABILITY,
        HomePinsController.prototype[method],
      );
      expect(capability).toBe('work.read');
    }
  });
});
