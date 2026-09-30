import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { InsightDashboardLayoutController } from './dashboard-layout.controller.js';
import {
  DEFAULT_INSIGHT_DASHBOARD_TILES,
  InsightDashboardLayoutService,
} from './dashboard-layout.service.js';
import type { InsightDashboardLayoutRepository } from './dashboard-layout.repository.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type {
  InsightDashboardLayoutRow,
  InsightDashboardTile,
} from '../../common/database/schema.js';

/**
 * Per-user insight dashboard layout (x302) — read/upsert over fakes, always the caller's own.
 *
 * The database is faked; the properties proved are the ones the HTTP surface owns: absence reads the
 * shipped default, a valid save persists and reads back, an unknown metric key is a 400 with no
 * write (the mandated refusal), a duplicate key is a 400 with no write, the subject is
 * `principal.membershipId` and never a body value (so no caller can read or write another
 * membership's layout), and both routes sit behind `work.read` (asserted through the route metadata
 * the `CapabilityGuard` reads).
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

/** An in-memory store keyed by membership, so a save is visible to the read-back it does. */
class FakeInsightDashboardLayoutRepository {
  readonly rows = new Map<string, readonly InsightDashboardTile[]>();
  upsertCalls: { membershipId: string; tiles: readonly InsightDashboardTile[] }[] = [];

  findForMembership(
    _r: unknown,
    _c: unknown,
    membershipId: string,
  ): Promise<InsightDashboardLayoutRow | null> {
    const tiles = this.rows.get(membershipId);
    return Promise.resolve(tiles ? ({ tilesJson: tiles } as InsightDashboardLayoutRow) : null);
  }

  upsert(
    _r: unknown,
    _c: unknown,
    membershipId: string,
    tiles: readonly InsightDashboardTile[],
  ): Promise<void> {
    this.upsertCalls.push({ membershipId, tiles });
    this.rows.set(membershipId, tiles);
    return Promise.resolve();
  }
}

function controllerWith(
  repo: FakeInsightDashboardLayoutRepository,
): InsightDashboardLayoutController {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const service = new InsightDashboardLayoutService(
    database,
    repo as unknown as InsightDashboardLayoutRepository,
  );
  return new InsightDashboardLayoutController(service);
}

async function expectStatus<T>(promise: Promise<T>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

describe('InsightDashboardLayoutController (x302)', () => {
  it('reads the shipped default when the member has never saved', async () => {
    const repo = new FakeInsightDashboardLayoutRepository();
    const result = await controllerWith(repo).get(context, member());
    expect(result).toEqual({ tiles: DEFAULT_INSIGHT_DASHBOARD_TILES });
  });

  it('persists a valid layout and reads it back — always the caller’s own membership', async () => {
    const repo = new FakeInsightDashboardLayoutRepository();
    const controller = controllerWith(repo);
    const tiles = [
      { key: 'workload', position: 0, visible: true },
      { key: 'portfolio', position: 1, visible: false },
    ];

    const saved = await controller.put(context, member(), { tiles });
    expect(saved).toEqual({ tiles });

    // The subject is the authenticated principal's membership, never a value the request named.
    expect(repo.upsertCalls).toHaveLength(1);
    expect(repo.upsertCalls[0]!.membershipId).toBe(MY_MEMBERSHIP);

    const readBack = await controller.get(context, member());
    expect(readBack).toEqual({ tiles });
  });

  it('400s a body whose tile key is off the allowlist and writes nothing (refusal)', async () => {
    const repo = new FakeInsightDashboardLayoutRepository();
    await expectStatus(
      controllerWith(repo).put(context, member(), {
        tiles: [{ key: 'not-a-metric', position: 0, visible: true }],
      }),
      400,
    );
    expect(repo.upsertCalls).toHaveLength(0);
  });

  it('400s a body with duplicate tile keys and writes nothing', async () => {
    const repo = new FakeInsightDashboardLayoutRepository();
    await expectStatus(
      controllerWith(repo).put(context, member(), {
        tiles: [
          { key: 'workload', position: 0, visible: true },
          { key: 'workload', position: 1, visible: true },
        ],
      }),
      400,
    );
    expect(repo.upsertCalls).toHaveLength(0);
  });

  it('400s a tile with a non-integer position and writes nothing', async () => {
    const repo = new FakeInsightDashboardLayoutRepository();
    await expectStatus(
      controllerWith(repo).put(context, member(), {
        tiles: [{ key: 'workload', position: 1.5, visible: true }],
      }),
      400,
    );
    expect(repo.upsertCalls).toHaveLength(0);
  });

  it('400s a non-array tiles field and writes nothing', async () => {
    const repo = new FakeInsightDashboardLayoutRepository();
    await expectStatus(controllerWith(repo).put(context, member(), { tiles: 'workload' }), 400);
    expect(repo.upsertCalls).toHaveLength(0);
  });

  it('never reads another membership’s layout — the subject is always the principal', async () => {
    const repo = new FakeInsightDashboardLayoutRepository();
    // Another member has a saved layout; the caller must not see it.
    repo.rows.set(OTHER_MEMBERSHIP, [{ key: 'adoption', position: 0, visible: true }]);
    const result = await controllerWith(repo).get(context, member());
    expect(result).toEqual({ tiles: DEFAULT_INSIGHT_DASHBOARD_TILES });
  });

  it('guards both routes with work.read, so a caller without it is refused 403 by CapabilityGuard', () => {
    for (const method of ['get', 'put'] as const) {
      const capability = Reflect.getMetadata(
        REQUIRED_CAPABILITY,
        InsightDashboardLayoutController.prototype[method],
      );
      expect(capability).toBe('work.read');
    }
  });
});
