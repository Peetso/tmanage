import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { FocusBlocksController } from './focus-blocks.controller.js';
import { FocusBlocksService } from './focus-blocks.service.js';
import type { FocusBlocksRepository, CreateFocusBlockInput } from './focus-blocks.repository.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { FocusBlockRow } from '../../common/database/schema.js';

/**
 * CAL-04 focus blocks (x255) — create/list/delete over fakes, always the caller's own membership.
 *
 * The database is faked; the properties proved are the ones the HTTP surface owns: a well-formed create
 * persists as the caller's own membership, the required refusal (`endsAt <= startsAt` is a 400 and
 * nothing is written), the list is scoped to the caller's own membership in a bounded window, a delete
 * of another member's id is a 404 with no delete, and every route sits behind `work.read`.
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const MY_MEMBERSHIP = '00000000-0000-4000-8000-0000000000e1';
const OTHER_MEMBERSHIP = '00000000-0000-4000-8000-0000000000e2';

function member(): Principal {
  return {
    userId: '00000000-0000-4000-8000-0000000000c1',
    organizationId: ORG,
    kind: 'internal',
    role: 'member',
    membershipId: MY_MEMBERSHIP,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: false,
  };
}

const context = { organizationId: ORG, membershipId: MY_MEMBERSHIP } as unknown as TenantContext;

interface Stored {
  id: string;
  membershipId: string;
  startsAt: Date;
  endsAt: Date;
  title: string;
  createdAt: Date;
}

class FakeFocusBlocksRepository {
  readonly rows: Stored[] = [];
  createCalls: CreateFocusBlockInput[] = [];
  private seq = 0;

  create(_r: unknown, _c: unknown, input: CreateFocusBlockInput): Promise<FocusBlockRow> {
    this.createCalls.push(input);
    const row: Stored = {
      id: `fb-${++this.seq}`,
      ...input,
      createdAt: new Date('2026-06-15T00:00:00Z'),
    };
    this.rows.push(row);
    return Promise.resolve(row as unknown as FocusBlockRow);
  }

  deleteOwn(_r: unknown, _c: unknown, id: string, membershipId: string): Promise<boolean> {
    const before = this.rows.length;
    const kept = this.rows.filter((row) => !(row.id === id && row.membershipId === membershipId));
    this.rows.length = 0;
    this.rows.push(...kept);
    return Promise.resolve(kept.length < before);
  }

  listForMember(
    _r: unknown,
    _c: unknown,
    membershipId: string,
    from: Date,
    to: Date,
  ): Promise<readonly FocusBlockRow[]> {
    return Promise.resolve(
      this.rows.filter(
        (row) =>
          row.membershipId === membershipId &&
          row.startsAt.getTime() >= from.getTime() &&
          row.startsAt.getTime() < to.getTime(),
      ) as unknown as FocusBlockRow[],
    );
  }
}

function controllerWith(repo: FakeFocusBlocksRepository): FocusBlocksController {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const service = new FocusBlocksService(database, repo as unknown as FocusBlocksRepository);
  return new FocusBlocksController(service);
}

async function expectStatus<T>(promise: Promise<T>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

const VALID = {
  startsAt: '2026-06-15T09:00:00.000Z',
  endsAt: '2026-06-15T11:00:00.000Z',
  title: 'Deep work',
};

describe('FocusBlocksController (CAL-04, x255)', () => {
  it('creates a well-formed block as the caller’s own membership', async () => {
    const repo = new FakeFocusBlocksRepository();
    const view = await controllerWith(repo).create(context, member(), { ...VALID });
    expect(view.title).toBe('Deep work');
    expect(view.startsAt).toBe('2026-06-15T09:00:00.000Z');
    expect(repo.createCalls).toHaveLength(1);
    expect(repo.createCalls[0]!.membershipId).toBe(MY_MEMBERSHIP);
  });

  it('400s a block whose endsAt is not after startsAt and writes nothing (the refusal)', async () => {
    const repo = new FakeFocusBlocksRepository();
    await expectStatus(
      controllerWith(repo).create(context, member(), {
        ...VALID,
        endsAt: VALID.startsAt,
      }),
      400,
    );
    expect(repo.createCalls).toHaveLength(0);
    expect(repo.rows).toHaveLength(0);
  });

  it('400s a block that spans more than 24 hours and writes nothing', async () => {
    const repo = new FakeFocusBlocksRepository();
    await expectStatus(
      controllerWith(repo).create(context, member(), {
        startsAt: '2026-06-15T09:00:00.000Z',
        endsAt: '2026-06-16T10:00:00.000Z',
        title: 'Too long',
      }),
      400,
    );
    expect(repo.createCalls).toHaveLength(0);
  });

  it('lists only the caller’s own blocks within the window', async () => {
    const repo = new FakeFocusBlocksRepository();
    await controllerWith(repo).create(context, member(), { ...VALID });
    repo.rows.push({
      id: 'other',
      membershipId: OTHER_MEMBERSHIP,
      startsAt: new Date('2026-06-15T10:00:00Z'),
      endsAt: new Date('2026-06-15T11:00:00Z'),
      title: 'Not mine',
      createdAt: new Date(),
    });
    const { blocks } = await controllerWith(repo).list(
      context,
      member(),
      '2026-06-15T00:00:00.000Z',
      '2026-06-16T00:00:00.000Z',
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.title).toBe('Deep work');
  });

  it('400s a list whose to is not after from', async () => {
    await expectStatus(
      controllerWith(new FakeFocusBlocksRepository()).list(
        context,
        member(),
        '2026-06-16T00:00:00.000Z',
        '2026-06-15T00:00:00.000Z',
      ),
      400,
    );
  });

  it('404s deleting a block that is not the caller’s own', async () => {
    const repo = new FakeFocusBlocksRepository();
    repo.rows.push({
      id: 'other',
      membershipId: OTHER_MEMBERSHIP,
      startsAt: new Date('2026-06-15T10:00:00Z'),
      endsAt: new Date('2026-06-15T11:00:00Z'),
      title: 'Not mine',
      createdAt: new Date(),
    });
    await expectStatus(controllerWith(repo).remove(context, member(), 'other'), 404);
    expect(repo.rows).toHaveLength(1);
  });

  it('guards every route with work.read', () => {
    for (const method of ['list', 'create', 'remove'] as const) {
      const capability = Reflect.getMetadata(
        REQUIRED_CAPABILITY,
        FocusBlocksController.prototype[method],
      );
      expect(capability).toBe('work.read');
    }
  });
});
