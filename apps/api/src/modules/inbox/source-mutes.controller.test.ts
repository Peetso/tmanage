import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { InboxSourceMutesController } from './source-mutes.controller.js';
import { InboxSourceMutesService } from './source-mutes.service.js';
import type { InboxMuteObjectType, InboxSourceMutesRepository } from './source-mutes.repository.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { InboxSourceMuteRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * x318 mute/list/un-mute over fakes. The database is faked; the safety this slice owns is the
 * service's: an off-allowlist object_type is a 400 with no insert (the required refusal), a GET
 * returns only the caller's own rows (never another member's), and all three routes sit behind
 * `work.read` (the metadata `CapabilityGuard` reads, so a caller without it is refused before any
 * handler runs and nothing is inserted).
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const ME = '00000000-0000-4000-8000-0000000000c1';
const OTHER = '00000000-0000-4000-8000-0000000000c2';
const WORK_ITEM = '00000000-0000-4000-8000-0000000000d1';

function ctx(userId: string): TenantContext {
  return { organizationId: ORG, userId } as unknown as TenantContext;
}

/** An in-memory repository scoped by member_user_id, like the real one. */
class FakeRepo {
  readonly rows: InboxSourceMuteRow[] = [];
  insertCalls = 0;
  deleteCalls = 0;

  findOwn(
    _r: unknown,
    _c: unknown,
    memberUserId: string,
    objectType: InboxMuteObjectType,
    objectId: string,
  ): Promise<InboxSourceMuteRow | undefined> {
    return Promise.resolve(
      this.rows.find(
        (row) =>
          row.memberUserId === memberUserId &&
          row.objectType === objectType &&
          row.objectId === objectId,
      ),
    );
  }

  insert(
    _r: unknown,
    _c: unknown,
    memberUserId: string,
    objectType: InboxMuteObjectType,
    objectId: string,
  ): Promise<void> {
    this.insertCalls += 1;
    this.rows.push({
      id: `mute-${this.rows.length + 1}`,
      organizationId: ORG,
      memberUserId,
      objectType,
      objectId,
      createdAt: new Date('2026-09-27T00:00:00.000Z'),
    });
    return Promise.resolve();
  }

  deleteOwn(
    _r: unknown,
    _c: unknown,
    memberUserId: string,
    objectType: InboxMuteObjectType,
    objectId: string,
  ): Promise<boolean> {
    this.deleteCalls += 1;
    const index = this.rows.findIndex(
      (row) =>
        row.memberUserId === memberUserId &&
        row.objectType === objectType &&
        row.objectId === objectId,
    );
    if (index === -1) return Promise.resolve(false);
    this.rows.splice(index, 1);
    return Promise.resolve(true);
  }

  listForMember(_r: unknown, _c: unknown, memberUserId: string): Promise<InboxSourceMuteRow[]> {
    return Promise.resolve(this.rows.filter((row) => row.memberUserId === memberUserId));
  }
}

function controllerWith(repo: FakeRepo): InboxSourceMutesController {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const service = new InboxSourceMutesService(
    database,
    repo as unknown as InboxSourceMutesRepository,
  );
  return new InboxSourceMutesController(service);
}

async function expectStatus<T>(promise: Promise<T>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

describe('InboxSourceMutesController (x318)', () => {
  it('mutes, lists, and un-mutes — the own-scoped round trip; re-mute is idempotent', async () => {
    const repo = new FakeRepo();
    const controller = controllerWith(repo);

    const afterMute = await controller.mute(ctx(ME), {
      objectType: 'work_item',
      objectId: WORK_ITEM,
    });
    expect(afterMute.mutes).toEqual([
      { objectType: 'work_item', objectId: WORK_ITEM, createdAt: '2026-09-27T00:00:00.000Z' },
    ]);

    // Re-muting the same source is a no-op: no second insert, still one row.
    const afterRemute = await controller.mute(ctx(ME), {
      objectType: 'work_item',
      objectId: WORK_ITEM,
    });
    expect(afterRemute.mutes).toHaveLength(1);
    expect(repo.insertCalls).toBe(1);

    await controller.unmute(ctx(ME), { objectType: 'work_item', objectId: WORK_ITEM });
    expect((await controller.list(ctx(ME))).mutes).toEqual([]);
  });

  it('400s an off-allowlist object_type (or malformed id) and does not insert (the refusal)', async () => {
    const repo = new FakeRepo();
    const controller = controllerWith(repo);

    await expectStatus(
      controller.mute(ctx(ME), { objectType: 'project', objectId: WORK_ITEM }),
      400,
    );
    await expectStatus(controller.mute(ctx(ME), { objectType: 42, objectId: WORK_ITEM }), 400);
    await expectStatus(controller.mute(ctx(ME), { objectType: 'work_item', objectId: '' }), 400);
    await expectStatus(controller.mute(ctx(ME), { objectType: 'work_item' }), 400);
    expect(repo.insertCalls).toBe(0);
    expect(repo.rows).toHaveLength(0);
  });

  it('GET returns only the caller rows, never another member’s mutes', async () => {
    const repo = new FakeRepo();
    const controller = controllerWith(repo);

    await controller.mute(ctx(ME), { objectType: 'work_item', objectId: WORK_ITEM });
    await controller.mute(ctx(OTHER), { objectType: 'client_request', objectId: WORK_ITEM });

    const mine = await controller.list(ctx(ME));
    expect(mine.mutes).toEqual([
      { objectType: 'work_item', objectId: WORK_ITEM, createdAt: '2026-09-27T00:00:00.000Z' },
    ]);
  });

  it('guards every route with work.read (the capability CapabilityGuard reads)', () => {
    for (const method of ['list', 'mute', 'unmute'] as const) {
      expect(
        Reflect.getMetadata(REQUIRED_CAPABILITY, InboxSourceMutesController.prototype[method]),
      ).toBe('work.read');
    }
  });
});
