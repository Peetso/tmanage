import 'reflect-metadata';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { WorkBoardColumnsController } from './board-columns.controller.js';
import { WorkBoardColumnsService } from './board-columns.service.js';
import type { WorkBoardColumnsRepository } from './board-columns.repository.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkBoardColumnRow } from '../../common/database/schema.js';

/**
 * x308 — the fast, database-free proof of the work board columns. It runs the controller over an
 * in-memory column store with the **real** `authorize`: the org-wide `org.manage` write gate (a
 * caller without it is refused 403 with no insert), the resolve-then-authorize order (an edit of a
 * cross-tenant column id is a 404 with no write), the state-key allowlist (off it is a 400), the
 * empty-label 400 and the one-column-per-slot 409 are what a wiring bug would break. The immutable
 * trigger and the composite keys are proved against the engine by the chain's DB suite.
 */

const ORG = '01890000-0000-7000-8000-00000000000a';
const MEMBERSHIP = '01890000-0000-7000-8000-000000000011';

const context = { organizationId: ORG } as unknown as TenantContext;

/** An owner — the only internal role whose ceiling holds `org.manage`. */
function owner(): Principal {
  return {
    userId: '01890000-0000-7000-8000-000000000001',
    organizationId: ORG,
    kind: 'internal',
    role: 'owner',
    membershipId: MEMBERSHIP,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

/** A member — authenticated, but without `org.manage`, so the write authorize denies. */
function member(): Principal {
  return { ...owner(), role: 'member', hasOrgWideScope: false };
}

/** In-memory column store standing in for the repository, counting its writes. */
class FakeColumnsRepository {
  readonly rows: WorkBoardColumnRow[] = [];
  writes = 0;

  constructor(seed: readonly WorkBoardColumnRow[] = []) {
    this.rows.push(...seed);
  }

  async list() {
    return [...this.rows].sort((a, b) => a.position - b.position);
  }
  async findById(_r: unknown, _c: TenantContext, id: string) {
    return this.rows.find((row) => row.id === id) ?? null;
  }
  async findByPosition(_r: unknown, _c: TenantContext, position: number) {
    return this.rows.find((row) => row.position === position) ?? null;
  }
  async create(
    _r: unknown,
    _c: TenantContext,
    input: { label: string; stateKey: string; position: number },
  ) {
    this.writes += 1;
    const row: WorkBoardColumnRow = {
      id: `col-${this.rows.length + 1}`,
      organizationId: ORG,
      label: input.label,
      stateKey: input.stateKey,
      position: input.position,
      createdAt: new Date('2026-09-27T00:00:00.000Z'),
    };
    this.rows.push(row);
    return row;
  }
  async update(
    _r: unknown,
    _c: TenantContext,
    id: string,
    input: { label: string; stateKey: string; position: number },
  ) {
    this.writes += 1;
    const row = this.rows.find((r) => r.id === id) as WorkBoardColumnRow;
    row.label = input.label;
    row.stateKey = input.stateKey;
    row.position = input.position;
    return row;
  }
  async delete(_r: unknown, _c: TenantContext, id: string) {
    const before = this.rows.length;
    const at = this.rows.findIndex((row) => row.id === id);
    if (at >= 0) this.rows.splice(at, 1);
    return this.rows.length < before;
  }
}

function harness(seed: readonly WorkBoardColumnRow[] = []) {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const repo = new FakeColumnsRepository(seed);
  const service = new WorkBoardColumnsService(
    database,
    repo as unknown as WorkBoardColumnsRepository,
  );
  return { controller: new WorkBoardColumnsController(service), repo };
}

async function statusOf(work: () => Promise<unknown>): Promise<number> {
  try {
    await work();
  } catch (error) {
    if (error instanceof ApiError) return error.status;
    throw error;
  }
  throw new Error('expected the call to throw');
}

describe('WorkBoardColumnsController', () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness();
  });

  it('defines a column and lists it, position-ascending', async () => {
    await h.controller.define(context, owner(), {
      label: 'Doing',
      stateKey: 'in_progress',
      position: 1,
    });
    await h.controller.define(context, owner(), {
      label: 'To do',
      stateKey: 'backlog',
      position: 0,
    });
    const listed = await h.controller.list(context);
    expect(listed.columns.map((c) => c.label)).toEqual(['To do', 'Doing']);
    expect(listed.columns[0]).toMatchObject({ stateKey: 'backlog', position: 0 });
  });

  it('rejects an off-allowlist state key and an empty label with 400, no insert', async () => {
    expect(
      await statusOf(() =>
        h.controller.define(context, owner(), { label: 'X', stateKey: 'shipping', position: 0 }),
      ),
    ).toBe(400);
    expect(
      await statusOf(() =>
        h.controller.define(context, owner(), { label: '  ', stateKey: 'backlog', position: 0 }),
      ),
    ).toBe(400);
    expect(h.repo.writes).toBe(0);
  });

  it('refuses a second column claiming an occupied slot with 409', async () => {
    await h.controller.define(context, owner(), {
      label: 'To do',
      stateKey: 'backlog',
      position: 0,
    });
    expect(
      await statusOf(() =>
        h.controller.define(context, owner(), { label: 'Dupe', stateKey: 'ready', position: 0 }),
      ),
    ).toBe(409);
  });

  it('edits a column in place and removes it', async () => {
    const created = await h.controller.define(context, owner(), {
      label: 'Doing',
      stateKey: 'in_progress',
      position: 0,
    });
    const edited = await h.controller.update(context, owner(), created.id, {
      label: 'In progress',
      stateKey: 'in_progress',
      position: 0,
    });
    expect(edited).toMatchObject({ id: created.id, label: 'In progress', position: 0 });
    await h.controller.remove(context, owner(), created.id);
    expect((await h.controller.list(context)).columns).toHaveLength(0);
  });

  it('refuses a define without org.manage with 403 and writes nothing', async () => {
    const status = await statusOf(() =>
      h.controller.define(context, member(), { label: 'To do', stateKey: 'backlog', position: 0 }),
    );
    expect(status).toBe(403);
    expect(h.repo.writes).toBe(0);
  });

  it('answers 404 and writes nothing when editing a cross-tenant or absent column id', async () => {
    const status = await statusOf(() =>
      h.controller.update(context, owner(), 'no-such-column', {
        label: 'X',
        stateKey: 'backlog',
        position: 0,
      }),
    );
    expect(status).toBe(404);
    expect(h.repo.writes).toBe(0);
  });
});
