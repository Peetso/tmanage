import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { RecentItemsController } from './recent-items.controller.js';
import { RecentItemsService } from './recent-items.service.js';
import type { RecentItemsRepository } from './recent-items.repository.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { HomeRecentItemRow, RecentItemObjectType } from '../../common/database/schema.js';

/**
 * HOME recents (x324) record/list over fakes.
 *
 * The database is faked, but the two rules that are the whole of this slice's safety are proven with
 * the real service and controller: recents are private to a membership (a read never returns another
 * member's rows, and a recorded view is written under the acting membership), and the routes sit
 * behind `work.read` (a caller without it is refused 403 by `CapabilityGuard`, asserted through the
 * route metadata the guard reads). Validation refuses an off-allowlist `object_type` and a missing
 * `object_id` with a 400 and no upsert.
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const MY_MEMBERSHIP = '00000000-0000-4000-8000-0000000000e1';
const OTHER_MEMBERSHIP = '00000000-0000-4000-8000-0000000000e2';
const WORK_ITEM = '00000000-0000-4000-8000-0000000000d1';
const PROJECT_ID = '00000000-0000-4000-8000-0000000000b1';

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

/** An in-memory {@link RecentItemsRepository}: upsert by the unique key, list own newest-first. */
class FakeRecentItemsRepository {
  readonly rows: HomeRecentItemRow[] = [];
  recordCalls = 0;
  private nextId = 1;

  recordView(
    _r: unknown,
    _c: unknown,
    input: {
      membershipId: string;
      objectType: RecentItemObjectType;
      objectId: string;
      viewedAt: Date;
    },
  ): Promise<void> {
    this.recordCalls += 1;
    const existing = this.rows.find(
      (row) =>
        row.membershipId === input.membershipId &&
        row.objectType === input.objectType &&
        row.objectId === input.objectId,
    );
    if (existing) {
      existing.viewedAt = input.viewedAt;
    } else {
      this.rows.push({
        id: `recent-${this.nextId++}`,
        organizationId: ORG,
        membershipId: input.membershipId,
        objectType: input.objectType,
        objectId: input.objectId,
        viewedAt: input.viewedAt,
        createdAt: new Date('2026-09-27T00:00:00.000Z'),
      });
    }
    return Promise.resolve();
  }

  listForMembership(_r: unknown, _c: unknown, membershipId: string): Promise<HomeRecentItemRow[]> {
    return Promise.resolve(
      this.rows
        .filter((row) => row.membershipId === membershipId)
        .sort((a, b) => b.viewedAt.getTime() - a.viewedAt.getTime() || a.id.localeCompare(b.id)),
    );
  }
}

function controllerWith(repo: FakeRecentItemsRepository): RecentItemsController {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const service = new RecentItemsService(database, repo as unknown as RecentItemsRepository);
  return new RecentItemsController(database, service);
}

async function expectStatus<T>(promise: Promise<T>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

describe('RecentItemsController (HOME recents, x324)', () => {
  it('records a view and lists it — the own-scoped round trip, idempotent (no second row)', async () => {
    const repo = new FakeRecentItemsRepository();
    const controller = controllerWith(repo);

    const after = await controller.record(context, member(), {
      objectType: 'work',
      objectId: WORK_ITEM,
    });
    expect(after.items).toEqual([
      {
        id: 'recent-1',
        objectType: 'work',
        objectId: WORK_ITEM,
        viewedAt: after.items[0]!.viewedAt,
      },
    ]);

    // A repeat view refreshes the time in place — still one row.
    await controller.record(context, member(), { objectType: 'work', objectId: WORK_ITEM });
    const listed = await controller.list(context, member());
    expect(listed.items).toHaveLength(1);
    expect(repo.rows).toHaveLength(1);
    expect(repo.recordCalls).toBe(2);
  });

  it('400s an off-allowlist object_type, with no upsert', async () => {
    const repo = new FakeRecentItemsRepository();
    const controller = controllerWith(repo);

    await expectStatus(
      controller.record(context, member(), { objectType: 'client_request', objectId: WORK_ITEM }),
      400,
    );
    expect(repo.recordCalls).toBe(0);
    expect(repo.rows).toHaveLength(0);
  });

  it('400s a missing object_id, with no upsert', async () => {
    const repo = new FakeRecentItemsRepository();
    const controller = controllerWith(repo);

    await expectStatus(controller.record(context, member(), { objectType: 'work' }), 400);
    expect(repo.recordCalls).toBe(0);
  });

  it('never lists another member’s recents', async () => {
    const repo = new FakeRecentItemsRepository();
    const controller = controllerWith(repo);
    repo.rows.push({
      id: 'recent-other',
      organizationId: ORG,
      membershipId: OTHER_MEMBERSHIP,
      objectType: 'project',
      objectId: PROJECT_ID,
      viewedAt: new Date('2026-09-26T00:00:00.000Z'),
      createdAt: new Date('2026-09-26T00:00:00.000Z'),
    });

    const mine = await controller.list(context, member());
    expect(mine).toEqual({ items: [] });
  });

  it('guards every route with work.read, so a caller without it is refused 403 by CapabilityGuard', () => {
    for (const method of ['list', 'record'] as const) {
      const capability = Reflect.getMetadata(
        REQUIRED_CAPABILITY,
        RecentItemsController.prototype[method],
      );
      expect(capability).toBe('work.read');
    }
  });
});
