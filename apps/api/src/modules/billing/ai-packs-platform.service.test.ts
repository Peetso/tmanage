import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@tmanage/domain';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { ApiError } from '../../common/http/errors.js';
import type { PlatformAdminActor } from '../platform-admin/platform-admin.guard.js';
import { PLATFORM_AUDIT_ACTIONS } from '../platform-admin/platform-audit-actions.js';
import {
  AiPacksPlatformService,
  parsePackCredits,
  parsePoolClass,
} from './ai-packs-platform.service.js';
import type { AiPackRequestRecord, AiPacksRepository } from './ai-packs.repository.js';

/**
 * 62-07 — the platform admin's test list and pack grants on an in-memory repository: inputs are
 * parsed once at the boundary (IP-2), the workspace must exist (404) and be on the list for a
 * grant (409), a request is decided once, and every change writes one platform audit row in the
 * same transaction (DA-11). The platform audit insert is recorded from the statement the
 * transaction runs.
 */

const NOW = new Date('2026-11-20T10:00:00.000Z');
const ORG = uuidv7();
const REQUEST = { correlationId: uuidv7(), ip: null, userAgent: null };
const ACTOR = {
  account: { userId: uuidv7(), email: 'admin@tmanage.example' },
} as unknown as PlatformAdminActor;

function setup(initial: { listed: boolean; request?: AiPackRequestRecord | null }) {
  const audits: unknown[][] = [];
  const runner = {
    query: async (_sql: string, params: unknown[]) => {
      audits.push(params);
      return [];
    },
    execute: async () => [],
  } as unknown as TenantQueryRunner;
  const state = {
    listedAt: initial.listed ? new Date('2026-11-01T00:00:00.000Z') : null,
    poolClass: 'customers' as 'customers' | 'testing',
    packs: [] as { sizeCredits: number; requestedByMembershipId: string | null }[],
    request: initial.request ?? null,
    decided: [] as string[],
  };
  const repo = {
    organization: async (_t: TenantQueryRunner, ctx: TenantContext) =>
      ctx.organizationId === ORG ? { id: ORG, name: 'Northstar', slug: 'northstar' } : null,
    settings: async () => ({
      onTestList: state.listedAt !== null,
      testListAt: state.listedAt,
      poolClass: state.poolClass,
      memberSharePercent: 50,
    }),
    writePlatformSettings: async (
      _t: TenantQueryRunner,
      _c: TenantContext,
      input: { testListAt: Date | null; poolClass: 'customers' | 'testing' },
    ) => {
      state.listedAt = input.testListAt;
      state.poolClass = input.poolClass;
    },
    lockRequest: async (_t: TenantQueryRunner, _c: TenantContext, id: string) =>
      state.request?.id === id ? state.request : null,
    insertPack: async (
      _t: TenantQueryRunner,
      _c: TenantContext,
      pack: { sizeCredits: number; requestedByMembershipId: string | null },
    ) => {
      state.packs.push(pack);
    },
    decideRequest: async (
      _t: TenantQueryRunner,
      _c: TenantContext,
      input: { requestId: string; status: string },
    ) => {
      if (state.request?.id !== input.requestId || state.request.status !== 'open') return false;
      state.request = { ...state.request, status: input.status as 'granted' | 'declined' };
      state.decided.push(input.status);
      return true;
    },
  };
  const service = new AiPacksPlatformService({
    database: {
      transaction: async (_ctx: TenantContext, work: (tx: TenantQueryRunner) => unknown) =>
        work(runner),
      bootstrapRead: async () => {
        throw new Error('not in this test');
      },
    } as never,
    repository: repo as unknown as AiPacksRepository,
    platformCapMicroUsd: 100_000_000,
    now: () => NOW,
  });
  /** The platform audit actions written, read from the audit insert's bound parameters. */
  const actions = () =>
    audits.flatMap((params) =>
      params.filter(
        (p): p is string =>
          typeof p === 'string' && (PLATFORM_AUDIT_ACTIONS as readonly string[]).includes(p),
      ),
    );
  return { service, state, actions };
}

async function status(work: Promise<unknown>): Promise<number | 'ok'> {
  try {
    await work;
    return 'ok';
  } catch (error) {
    if (error instanceof ApiError) return error.status;
    throw error;
  }
}

const REASON = 'Pilot company agreed to test';

describe('parse at the boundary', () => {
  it('a pack is 1 to the whole platform cap in whole credits', () => {
    expect(parsePackCredits(500, 100_000)).toBe(500);
    for (const bad of [0, -1, 1.5, '500', 100_001, null]) {
      expect(() => parsePackCredits(bad, 100_000)).toThrow(ApiError);
    }
  });

  it('the pool class is customers or testing, or absent', () => {
    expect(parsePoolClass('testing')).toBe('testing');
    expect(parsePoolClass(undefined)).toBeNull();
    expect(() => parsePoolClass('reserve')).toThrow(ApiError);
  });
});

describe('the test list', () => {
  it('adds, changes the pool, removes — each with its own audited action and a reason', async () => {
    const { service, state, actions } = setup({ listed: false });
    const added = await service.setEntry(ACTOR, ORG, { onTestList: true, reason: REASON }, REQUEST);
    expect(added).toMatchObject({ listedAt: NOW.toISOString(), poolClass: 'customers' });
    await service.setEntry(
      ACTOR,
      ORG,
      { onTestList: true, poolClass: 'testing', reason: REASON },
      REQUEST,
    );
    expect(state.listedAt).toEqual(NOW); // the first listing time is kept
    await service.setEntry(ACTOR, ORG, { onTestList: false, reason: REASON }, REQUEST);
    expect(state.listedAt).toBeNull();
    expect(actions()).toEqual([
      'platform.ai_test_list_added',
      'platform.ai_pool_class_changed',
      'platform.ai_test_list_removed',
    ]);
  });

  it('refuses a missing reason, a bad id and an unknown workspace with nothing written', async () => {
    const { service, actions } = setup({ listed: false });
    expect(await status(service.setEntry(ACTOR, ORG, { onTestList: true }, REQUEST))).toBe(400);
    expect(
      await status(service.setEntry(ACTOR, 'x', { onTestList: true, reason: REASON }, REQUEST)),
    ).toBe(400);
    expect(
      await status(
        service.setEntry(ACTOR, uuidv7(), { onTestList: true, reason: REASON }, REQUEST),
      ),
    ).toBe(404);
    expect(actions()).toEqual([]);
  });
});

describe('pack grants', () => {
  const openRequest = (): AiPackRequestRecord => ({
    id: uuidv7(),
    status: 'open',
    requestedByMembershipId: uuidv7(),
    requestedAt: NOW,
    decidedAt: null,
    packId: null,
  });

  it('a workspace off the test list gets no pack (409)', async () => {
    const { service, state } = setup({ listed: false });
    expect(
      await status(service.grantPack(ACTOR, ORG, { sizeCredits: 500, reason: REASON }, REQUEST)),
    ).toBe(409);
    expect(state.packs).toEqual([]);
  });

  it('grants against the open request once, 6 months, audited; a second grant on it is a 409', async () => {
    const request = openRequest();
    const { service, state, actions } = setup({ listed: true, request });
    const grant = await service.grantPack(
      ACTOR,
      ORG,
      { sizeCredits: 500, requestId: request.id, reason: REASON },
      REQUEST,
    );
    expect(grant).toMatchObject({
      sizeCredits: 500,
      requestId: request.id,
      expiresAt: '2027-05-20T10:00:00.000Z',
    });
    expect(state.packs).toEqual([
      expect.objectContaining({
        sizeCredits: 500,
        requestedByMembershipId: request.requestedByMembershipId,
      }),
    ]);
    expect(
      await status(
        service.grantPack(
          ACTOR,
          ORG,
          { sizeCredits: 500, requestId: request.id, reason: REASON },
          REQUEST,
        ),
      ),
    ).toBe(409);
    expect(actions()).toEqual(['platform.ai_pack_granted']);
  });

  it('declines an open request once', async () => {
    const request = openRequest();
    const { service, state, actions } = setup({ listed: true, request });
    await service.declineRequest(ACTOR, ORG, request.id, {}, REQUEST);
    expect(state.decided).toEqual(['declined']);
    expect(await status(service.declineRequest(ACTOR, ORG, request.id, {}, REQUEST))).toBe(409);
    expect(await status(service.declineRequest(ACTOR, ORG, uuidv7(), {}, REQUEST))).toBe(404);
    expect(actions()).toEqual(['platform.ai_pack_request_declined']);
  });
});
