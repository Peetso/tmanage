import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { NotificationKindPrefsController } from './notification-kind-prefs.controller.js';
import type { NotificationKindPrefsRepository } from './notification-kind-prefs.repository.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { NOTIFICATION_KINDS } from '../../common/database/schema.js';
import type { NotificationKind, NotificationKindPrefRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * Per-kind notification opt-out (x152) set/list over fakes.
 *
 * The database is faked, but the properties that are the whole of this slice's safety are proved
 * directly: a set-then-list round trip lists every kind with unset ones defaulted to enabled, a kind
 * outside the closed enum is a 400 with no write (the Known trap), a non-boolean `enabled` is a 400,
 * the write is always the acting membership's (an upsert can never name another seat), one member
 * never sees another's rows, and the routes sit behind `work.read` (a caller without it is refused 403
 * by `CapabilityGuard`, asserted through the route metadata the guard reads).
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

/** An in-memory {@link NotificationKindPrefsRepository}: rows keyed by (membership, kind). */
class FakeRepo {
  readonly rows: NotificationKindPrefRow[] = [];
  upsertCalls: { membershipId: string; kind: NotificationKind; enabled: boolean }[] = [];
  private nextId = 1;

  listForMembership(
    _r: unknown,
    _c: unknown,
    membershipId: string,
  ): Promise<NotificationKindPrefRow[]> {
    return Promise.resolve(this.rows.filter((row) => row.membershipId === membershipId));
  }

  upsert(
    _r: unknown,
    _c: unknown,
    membershipId: string,
    kind: NotificationKind,
    enabled: boolean,
  ): Promise<void> {
    this.upsertCalls.push({ membershipId, kind, enabled });
    const existing = this.rows.find(
      (row) => row.membershipId === membershipId && row.kind === kind,
    );
    if (existing) {
      (existing as { enabled: boolean }).enabled = enabled;
    } else {
      this.rows.push({
        id: `pref-${this.nextId++}`,
        organizationId: ORG,
        membershipId,
        kind,
        enabled,
        updatedAt: new Date('2026-09-21T00:00:00.000Z'),
      });
    }
    return Promise.resolve();
  }
}

function controllerWith(repo: FakeRepo): NotificationKindPrefsController {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  return new NotificationKindPrefsController(
    database,
    repo as unknown as NotificationKindPrefsRepository,
  );
}

async function expectStatus<T>(promise: Promise<T>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

describe('NotificationKindPrefsController (per-kind opt-out, x152)', () => {
  it('sets one kind and lists every kind, unset ones defaulted to enabled — the own-scoped round trip', async () => {
    const repo = new FakeRepo();
    const controller = controllerWith(repo);

    const afterSet = await controller.set(context, member(), 'file', { enabled: false });
    // Every kind is present; the one just set is off, the rest default to on.
    expect(afterSet.kinds).toEqual(
      NOTIFICATION_KINDS.map((kind) => ({ kind, enabled: kind !== 'file' })),
    );
    expect(repo.upsertCalls).toEqual([
      { membershipId: MY_MEMBERSHIP, kind: 'file', enabled: false },
    ]);

    const listed = await controller.list(context, member());
    expect(listed).toEqual(afterSet);
  });

  it('400s a kind outside the closed enum, without a write (Known trap)', async () => {
    const repo = new FakeRepo();
    const controller = controllerWith(repo);

    await expectStatus(controller.set(context, member(), 'meeting', { enabled: false }), 400);
    expect(repo.upsertCalls).toHaveLength(0);
    expect(repo.rows).toHaveLength(0);
  });

  it('400s a non-boolean enabled, without a write', async () => {
    const repo = new FakeRepo();
    const controller = controllerWith(repo);

    await expectStatus(
      controller.set(context, member(), 'file', { enabled: 'no' as unknown as boolean }),
      400,
    );
    expect(repo.upsertCalls).toHaveLength(0);
  });

  it('writes only under the acting membership and never lists another member’s rows', async () => {
    const repo = new FakeRepo();
    const controller = controllerWith(repo);
    // Another member has opted out of messages; it must never surface for, or be overwritten by, us.
    repo.rows.push({
      id: 'pref-other',
      organizationId: ORG,
      membershipId: OTHER_MEMBERSHIP,
      kind: 'message',
      enabled: false,
      updatedAt: new Date('2026-09-20T00:00:00.000Z'),
    });

    await controller.set(context, member(), 'message', { enabled: false });
    // The write named our seat, not the body's or another's.
    expect(repo.upsertCalls).toEqual([
      { membershipId: MY_MEMBERSHIP, kind: 'message', enabled: false },
    ]);
    // The other member's row is untouched, and our list shows only our own settings.
    const other = repo.rows.find((row) => row.membershipId === OTHER_MEMBERSHIP);
    expect(other?.enabled).toBe(false);
    const mine = await controller.list(context, member());
    expect(mine.kinds.find((k) => k.kind === 'message')?.enabled).toBe(false);
    // Exactly our own message row plus the other member's — no cross-write created a duplicate.
    expect(repo.rows.filter((row) => row.kind === 'message')).toHaveLength(2);
  });

  it('guards every route with work.read, so a caller without it is refused 403 by CapabilityGuard', () => {
    for (const method of ['list', 'set'] as const) {
      const capability = Reflect.getMetadata(
        REQUIRED_CAPABILITY,
        NotificationKindPrefsController.prototype[method],
      );
      expect(capability).toBe('work.read');
    }
  });
});
