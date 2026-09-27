import { beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { BulkTransitionController } from './bulk-transition.controller.js';
import { BulkTransitionService, MAX_BULK_TRANSITION } from './bulk-transition.service.js';
import type { WorkItemsService, WorkItemView } from './work-items.service.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext } from '../../common/database/tenant-context.js';

/**
 * x206 — the database-free proof of the bulk status transition.
 *
 * The single-item guards (real `authorize`, the state machine, the cross-tenant 404) are proved
 * over fakes in `work-checklist.controller.test.ts` and the work-item suites; this file proves
 * what only the bulk layer adds: it tenant-scopes **every** id through the single path, reports a
 * per-id outcome instead of failing the whole batch, never applies a transition for an id it
 * could not read, and rejects an over-cap batch with 400 before touching a single row.
 */

const ORG = '01890000-0000-7000-8000-00000000000a';
const context = { organizationId: ORG } as unknown as TenantContext;

function member(): Principal {
  return {
    userId: '01890000-0000-7000-8000-000000000001',
    organizationId: ORG,
    kind: 'internal',
    role: 'member',
    membershipId: '01890000-0000-7000-8000-000000000011',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

type Behaviour = 'ok' | 'invalid' | 'forbidden' | 'conflict';

/**
 * Stands in for the real {@link WorkItemsService}. `get` reproduces the single read's contract —
 * an unknown id is a 404, never a soft answer — and `transition` reproduces each refusal the
 * single path can raise. It records every id it was asked to transition, so a test can assert
 * that an unreadable id never reached the write.
 */
class FakeWorkItems {
  readonly transitioned: string[] = [];
  constructor(private readonly rows: Map<string, { version: number; behaviour: Behaviour }>) {}

  async get(_c: TenantContext, _p: Principal, id: string): Promise<WorkItemView> {
    const row = this.rows.get(id);
    if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return { id, version: row.version, state: 'in_progress' } as unknown as WorkItemView;
  }

  async transition(
    _c: TenantContext,
    _p: Principal,
    id: string,
    _version: number,
    _to: unknown,
    _facts: unknown,
  ): Promise<WorkItemView> {
    this.transitioned.push(id);
    const row = this.rows.get(id);
    switch (row?.behaviour) {
      case 'invalid':
        throw new ApiError(422, 'validation_failed', 'A work item cannot move there');
      case 'forbidden':
        throw new ApiError(403, 'forbidden', MESSAGES.forbidden);
      case 'conflict':
        throw new ApiError(409, 'conflict', MESSAGES.conflict);
      default:
        return { id, state: 'done' } as unknown as WorkItemView;
    }
  }
}

function harness(rows: Map<string, { version: number; behaviour: Behaviour }>) {
  const fake = new FakeWorkItems(rows);
  const service = new BulkTransitionService(fake as unknown as WorkItemsService);
  return { controller: new BulkTransitionController(service), fake };
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

describe('BulkTransitionController', () => {
  let rows: Map<string, { version: number; behaviour: Behaviour }>;

  beforeEach(() => {
    rows = new Map([
      ['w-1', { version: 3, behaviour: 'ok' }],
      ['w-2', { version: 1, behaviour: 'ok' }],
    ]);
  });

  it('applies the transition to every readable, legal id and counts them', async () => {
    const { controller, fake } = harness(rows);
    const result = await controller.bulkTransition(context, member(), {
      ids: ['w-1', 'w-2'],
      targetStatus: 'done',
    });

    expect(result.targetStatus).toBe('done');
    expect(result.appliedCount).toBe(2);
    expect(result.results).toEqual([
      { id: 'w-1', outcome: 'applied', reason: null },
      { id: 'w-2', outcome: 'applied', reason: null },
    ]);
    expect(fake.transitioned).toEqual(['w-1', 'w-2']);
  });

  it('reports an illegal move per id without failing the batch', async () => {
    rows.set('w-2', { version: 1, behaviour: 'invalid' });
    const { controller } = harness(rows);
    const result = await controller.bulkTransition(context, member(), {
      ids: ['w-1', 'w-2'],
      targetStatus: 'done',
    });

    expect(result.appliedCount).toBe(1);
    expect(result.results[0]).toMatchObject({ id: 'w-1', outcome: 'applied' });
    expect(result.results[1]).toMatchObject({ id: 'w-2', outcome: 'skipped_invalid' });
  });

  it('reports a foreign-tenant or absent id as not_found and never transitions it', async () => {
    const { controller, fake } = harness(rows);
    const result = await controller.bulkTransition(context, member(), {
      ids: ['w-1', 'foreign'],
      targetStatus: 'done',
    });

    expect(result.appliedCount).toBe(1);
    expect(result.results[1]).toEqual({
      id: 'foreign',
      outcome: 'not_found',
      reason: MESSAGES.notFound,
    });
    // The trap: an id from another tenant must never reach the write.
    expect(fake.transitioned).toEqual(['w-1']);
  });

  it('maps a per-item transition refusal (403) to forbidden, not a thrown request', async () => {
    rows.set('w-2', { version: 1, behaviour: 'forbidden' });
    const { controller } = harness(rows);
    const result = await controller.bulkTransition(context, member(), {
      ids: ['w-2'],
      targetStatus: 'done',
    });
    expect(result.appliedCount).toBe(0);
    expect(result.results[0]).toMatchObject({ id: 'w-2', outcome: 'forbidden' });
  });

  it('rejects an over-cap batch with 400 and reads nothing', async () => {
    const { controller, fake } = harness(rows);
    const ids = Array.from({ length: MAX_BULK_TRANSITION + 1 }, (_v, i) => `w-${i}`);
    const status = await statusOf(() =>
      controller.bulkTransition(context, member(), { ids, targetStatus: 'done' }),
    );
    expect(status).toBe(400);
    expect(fake.transitioned).toEqual([]);
  });

  it('rejects an empty id list and an unknown target status with 400', async () => {
    const { controller } = harness(rows);
    expect(
      await statusOf(() =>
        controller.bulkTransition(context, member(), { ids: [], targetStatus: 'done' }),
      ),
    ).toBe(400);
    expect(
      await statusOf(() =>
        controller.bulkTransition(context, member(), { ids: ['w-1'], targetStatus: 'nope' }),
      ),
    ).toBe(400);
  });

  it('de-duplicates repeated ids so a caller cannot inflate the applied count', async () => {
    const { controller, fake } = harness(rows);
    const result = await controller.bulkTransition(context, member(), {
      ids: ['w-1', 'w-1', 'w-1'],
      targetStatus: 'done',
    });
    expect(result.appliedCount).toBe(1);
    expect(fake.transitioned).toEqual(['w-1']);
  });
});
