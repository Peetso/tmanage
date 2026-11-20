import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@tmanage/domain';
import { ApiError } from '../../../common/http/errors.js';
import {
  AI_POOL_ADMIN_SQL,
  type AiPoolAdminRepository,
  type AiPoolRow,
} from '../../copilot/ai-pool-admin.repository.js';
import type { AiPool } from '../../copilot/ai-tiers.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import { PLATFORM_AUDIT_ACTIONS } from '../platform-audit-actions.js';
import {
  AI_BUDGET_SETTING,
  PlatformAiBudgetSettings,
  defaultAiBudgetConfig,
  parseAiBudgetBody,
  parseReserveRelease,
  parseStoredAiBudget,
  serializeAiBudget,
} from './ai-budget.js';
import {
  AI_BUDGET_AUDIT_ACTIONS,
  AiBudgetSettingsService,
  requireFreshStepUp,
} from './ai-budget.service.js';
import { SETTINGS_SQL } from './settings.repository.js';

/**
 * 62-08 (plan 62 §5) — Platform settings → AI budget. The caps never pass the env ceiling (a body
 * above it is a 400, a stored row above a lowered ceiling reads as the default); lowering a cap
 * below what a pool already spent pauses it at once; the reserve moves only with a fresh step-up
 * and a reason; every change writes one platform audit row in its transaction (DA-11).
 */

const USD = 1_000_000;
const CEILING = 100 * USD;
const ENV = { AI_PLATFORM_CAP_MAX_USD: '100' };
const NOW = new Date('2026-11-20T10:00:00.000Z');
const REQUEST = { correlationId: uuidv7(), ip: null, userAgent: null };
const REASON = 'Pilot month needs more room';

function status(work: () => unknown): number | 'ok' {
  try {
    work();
    return 'ok';
  } catch (error) {
    if (error instanceof ApiError) return error.status;
    throw error;
  }
}

async function statusOf(work: Promise<unknown>): Promise<number | string> {
  try {
    await work;
    return 'ok';
  } catch (error) {
    if (error instanceof ApiError) return `${error.status} ${error.auditCode ?? error.code}`;
    throw error;
  }
}

describe('the caps stay within AI_PLATFORM_CAP_MAX_USD', () => {
  const body = (customers: number, testing: number, reserve: number) => ({
    customersCents: customers,
    testingCents: testing,
    reserveCents: reserve,
    sonnetEnabled: true,
    applyTo: 'this_month',
  });

  it('takes caps that sum to the ceiling or less', () => {
    expect(parseAiBudgetBody(body(6000, 2500, 1500), CEILING).capsMicroUsd).toEqual({
      customers: 60 * USD,
      testing: 25 * USD,
      reserve: 15 * USD,
    });
  });

  it('refuses a cap above the ceiling (400 ai_cap_above_ceiling) — alone or in the sum', () => {
    expect(() => parseAiBudgetBody(body(6000, 2500, 1501), CEILING)).toThrow(
      expect.objectContaining({ status: 400, auditCode: 'ai_cap_above_ceiling' }),
    );
    expect(status(() => parseAiBudgetBody(body(10_001, 0, 0), CEILING))).toBe(400);
  });

  it('refuses a missing switch, an unknown period and a fraction of a cent', () => {
    expect(
      status(() => parseAiBudgetBody({ ...body(1, 1, 1), sonnetEnabled: 'no' }, CEILING)),
    ).toBe(400);
    expect(status(() => parseAiBudgetBody({ ...body(1, 1, 1), applyTo: 'today' }, CEILING))).toBe(
      400,
    );
    expect(
      status(() => parseAiBudgetBody({ ...body(1, 1, 1), customersCents: 1.5 }, CEILING)),
    ).toBe(400);
  });

  it('reads a stored row above a lowered ceiling as the default caps, keeping the switches', () => {
    const stored = serializeAiBudget({
      capsMicroUsd: { customers: 60 * USD, testing: 25 * USD, reserve: 15 * USD },
      sonnetEnabled: false,
      paused: true,
    });
    expect(parseStoredAiBudget(stored, 50 * USD)).toEqual({
      ...defaultAiBudgetConfig(50 * USD),
      sonnetEnabled: false,
      paused: true,
    });
    expect(parseStoredAiBudget('not json', CEILING)).toEqual(defaultAiBudgetConfig(CEILING));
    expect(parseStoredAiBudget(null, CEILING).capsMicroUsd).toEqual({
      customers: 60 * USD,
      testing: 25 * USD,
      reserve: 15 * USD,
    });
  });

  it('the settings source hands the budget the stored caps, packs at its env share', async () => {
    const stored = serializeAiBudget({
      capsMicroUsd: { customers: 50 * USD, testing: 20 * USD, reserve: 30 * USD },
      sonnetEnabled: false,
      paused: false,
    });
    const source = new PlatformAiBudgetSettings(
      ENV,
      () =>
        ({
          get: async (key: string) => (key === AI_BUDGET_SETTING ? stored : null),
        }) as never,
    );
    expect(await source.current()).toEqual({
      poolCapsMicroUsd: { customers: 50 * USD, testing: 20 * USD, reserve: 30 * USD, packs: 0 },
      sonnetEnabled: false,
      paused: false,
    });
    expect(await source.poolCapMicroUsd('testing')).toBe(20 * USD);
    const none = new PlatformAiBudgetSettings(ENV, () => null);
    expect((await none.current()).poolCapsMicroUsd.customers).toBe(60 * USD);
  });

  it('a reserve release goes to customers or testing, at least one cent', () => {
    expect(parseReserveRelease({ to: 'testing', amountCents: 500 }, CEILING)).toEqual({
      to: 'testing',
      microUsd: 5 * USD,
    });
    expect(status(() => parseReserveRelease({ to: 'reserve', amountCents: 5 }, CEILING))).toBe(400);
    expect(status(() => parseReserveRelease({ to: 'testing', amountCents: 0 }, CEILING))).toBe(400);
  });
});

describe('the step-up for the reserve must be recent', () => {
  const WINDOW = 60;
  const stepUp = (confirmedMinutesAgo: number) => ({
    expiresAt: new Date(NOW.getTime() + (WINDOW - confirmedMinutesAgo) * 60_000),
    mfaVerified: true,
  });

  it('passes within 15 minutes and refuses older, expired or missing (403)', () => {
    expect(status(() => requireFreshStepUp(stepUp(14), NOW, WINDOW))).toBe('ok');
    expect(status(() => requireFreshStepUp(stepUp(16), NOW, WINDOW))).toBe(403);
    expect(status(() => requireFreshStepUp(stepUp(61), NOW, WINDOW))).toBe(403);
    expect(status(() => requireFreshStepUp(null, NOW, WINDOW))).toBe(403);
  });
});

describe('the pool admin SQL keeps settled + reserved <= cap honest', () => {
  it('pauses a pool left below its spend, resumes only fitting pools, reserve gives only what it has', () => {
    expect(AI_POOL_ADMIN_SQL.pauseOverCap).toContain(
      'settled_micro_usd + reserved_micro_usd > cap_micro_usd',
    );
    expect(AI_POOL_ADMIN_SQL.resumeFitting).toContain(
      'settled_micro_usd + reserved_micro_usd <= cap_micro_usd',
    );
    expect(AI_POOL_ADMIN_SQL.takeFromReserve).toContain(
      'cap_micro_usd >= settled_micro_usd + reserved_micro_usd + ?',
    );
    expect(AI_POOL_ADMIN_SQL.lockPeriod).toMatch(/order by pool for update$/);
  });
});

// ── The service on in-memory pools ─────────────────────────────────────────────

function actorWith(confirmedMinutesAgo: number | null): PlatformAdminActor {
  return {
    account: { userId: uuidv7(), email: 'admin@tmanage.example' },
    sessionId: uuidv7(),
    stepUp:
      confirmedMinutesAgo === null
        ? null
        : {
            expiresAt: new Date(NOW.getTime() + (60 - confirmedMinutesAgo) * 60_000),
            mfaVerified: true,
          },
  } as unknown as PlatformAdminActor;
}

function setup(spent: Partial<Record<AiPool, number>> = {}) {
  const rows = new Map<AiPool, AiPoolRow>();
  let setting: string | null = null;
  const statements: { sql: string; params: unknown[] }[] = [];
  const pools = {
    ensurePeriod: async (_tx: unknown, _p: string, caps: Record<AiPool, number>) => {
      for (const pool of ['customers', 'testing', 'reserve', 'packs'] as const) {
        if (!rows.has(pool)) {
          rows.set(pool, {
            pool,
            capMicroUsd: caps[pool],
            settledMicroUsd: spent[pool] ?? 0,
            reservedMicroUsd: 0,
            pausedAt: null,
            pausedReason: null,
          });
        }
      }
    },
    lockPeriod: async () => [...rows.values()],
    readPeriod: async () => [...rows.values()],
    setCap: async (_tx: unknown, pool: AiPool, _p: string, cap: number, now: Date) => {
      const row = rows.get(pool);
      if (!row) return false;
      const over = row.settledMicroUsd + row.reservedMicroUsd > cap;
      const pause = over && row.pausedAt === null;
      rows.set(pool, {
        ...row,
        capMicroUsd: cap,
        ...(pause ? { pausedAt: now, pausedReason: 'cap_lowered' } : {}),
      });
      return pause;
    },
    pauseAll: async (_tx: unknown, _p: string, now: Date) => {
      let n = 0;
      for (const [pool, row] of rows) {
        if (row.pausedAt === null) {
          rows.set(pool, { ...row, pausedAt: now, pausedReason: 'admin' });
          n += 1;
        }
      }
      return n;
    },
    resumeFitting: async () => {
      let n = 0;
      for (const [pool, row] of rows) {
        if (
          row.pausedAt !== null &&
          row.settledMicroUsd + row.reservedMicroUsd <= row.capMicroUsd
        ) {
          rows.set(pool, { ...row, pausedAt: null, pausedReason: null });
          n += 1;
        }
      }
      return n;
    },
    releaseReserve: async (_tx: unknown, to: AiPool, _p: string, microUsd: number) => {
      const reserve = rows.get('reserve');
      const target = rows.get(to);
      if (!reserve || !target) return false;
      if (reserve.capMicroUsd < reserve.settledMicroUsd + reserve.reservedMicroUsd + microUsd) {
        return false;
      }
      rows.set('reserve', { ...reserve, capMicroUsd: reserve.capMicroUsd - microUsd });
      rows.set(to, { ...target, capMicroUsd: target.capMicroUsd + microUsd });
      return true;
    },
  };
  const tx = {
    query: async (sql: string, params: unknown[]) => {
      statements.push({ sql, params });
      if (sql === SETTINGS_SQL.write) setting = String(params[1]);
      return [];
    },
  };
  const service = new AiBudgetSettingsService({
    database: {
      identityRead: async (_o: unknown, work: (db: unknown) => unknown) => work(tx),
      identityTransaction: async (_o: unknown, work: (db: unknown) => unknown) => work(tx),
    } as never,
    store: {
      readAll: async () =>
        new Map(
          setting === null
            ? []
            : [[AI_BUDGET_SETTING, { value: setting, updatedAt: NOW, updatedBy: 'Peter' }]],
        ),
    },
    pools: pools as unknown as AiPoolAdminRepository,
    env: ENV,
    now: () => NOW,
    stepUpWindowMinutes: 60,
  });
  /** The platform audit actions written, read from the audit insert's bound parameters. */
  const actions = () =>
    statements.flatMap(({ params }) =>
      params.filter(
        (p): p is string =>
          typeof p === 'string' && (PLATFORM_AUDIT_ACTIONS as readonly string[]).includes(p),
      ),
    );
  return { service, rows, actions, setting: () => setting };
}

const caps = (customers: number, testing: number, reserve: number, applyTo = 'this_month') => ({
  customersCents: customers * 100,
  testingCents: testing * 100,
  reserveCents: reserve * 100,
  sonnetEnabled: true,
  applyTo,
  reason: REASON,
});

describe('AiBudgetSettingsService', () => {
  it('lowering a cap below what the pool already spent pauses it at once, audited', async () => {
    const { service, actions } = setup({ customers: 30 * USD });
    await service.update(actorWith(null), caps(60, 25, 15), REQUEST); // creates this month's rows
    const view = await service.update(actorWith(null), caps(20, 25, 15), REQUEST);
    const customers = view.pools.find((p) => p.pool === 'customers');
    expect(customers).toMatchObject({
      capMicroUsd: 20 * USD,
      paused: true,
      pausedReason: 'cap_lowered',
    });
    expect(view.pools.find((p) => p.pool === 'testing')?.paused).toBe(false);
    expect(actions()).toEqual([AI_BUDGET_AUDIT_ACTIONS.updated, AI_BUDGET_AUDIT_ACTIONS.updated]);
  });

  it('next_month leaves this month’s rows alone and stores the caps', async () => {
    const { service, rows, setting } = setup({ customers: 30 * USD });
    await service.update(actorWith(null), caps(60, 25, 15), REQUEST);
    await service.update(actorWith(null), caps(20, 25, 15, 'next_month'), REQUEST);
    expect(rows.get('customers')).toMatchObject({ capMicroUsd: 60 * USD, pausedAt: null });
    expect(parseStoredAiBudget(setting(), CEILING).capsMicroUsd.customers).toBe(20 * USD);
  });

  it('refuses caps above the ceiling and a missing reason with nothing written', async () => {
    const { service, actions, setting } = setup();
    expect(await statusOf(service.update(actorWith(null), caps(60, 25, 16), REQUEST))).toBe(
      '400 ai_cap_above_ceiling',
    );
    expect(
      await statusOf(service.update(actorWith(null), { ...caps(60, 25, 15), reason: '' }, REQUEST)),
    ).toBe('400 validation_failed');
    expect(setting()).toBeNull();
    expect(actions()).toEqual([]);
  });

  it('pause stops every pool and stays in the setting; resume leaves an over-cap pool paused', async () => {
    const { service, actions, setting } = setup({ customers: 30 * USD });
    await service.update(actorWith(null), caps(60, 25, 15), REQUEST);
    const paused = await service.pause(actorWith(null), { reason: REASON }, REQUEST);
    expect(paused.paused).toBe(true);
    expect(paused.pools.every((p) => p.paused)).toBe(true);
    // A cap lowered under the spend while paused: resume must not reopen that pool.
    await service.update(actorWith(null), caps(20, 25, 15), REQUEST);
    const resumed = await service.resume(actorWith(null), { reason: REASON }, REQUEST);
    expect(resumed.paused).toBe(false);
    expect(resumed.pools.filter((p) => p.paused).map((p) => p.pool)).toEqual(['customers']);
    expect(parseStoredAiBudget(setting(), CEILING).paused).toBe(false);
    expect(actions()).toEqual([
      AI_BUDGET_AUDIT_ACTIONS.updated,
      AI_BUDGET_AUDIT_ACTIONS.paused,
      AI_BUDGET_AUDIT_ACTIONS.updated,
      AI_BUDGET_AUDIT_ACTIONS.resumed,
    ]);
  });

  it('releases the reserve only with a fresh step-up, a reason and enough reserve', async () => {
    const { service, rows, actions } = setup();
    const body = { to: 'customers', amountCents: 500, reason: REASON };
    expect(await statusOf(service.releaseReserve(actorWith(30), body, REQUEST))).toBe(
      '403 ai_reserve_step_up_stale',
    );
    expect(await statusOf(service.releaseReserve(actorWith(null), body, REQUEST))).toBe(
      '403 ai_reserve_step_up_stale',
    );
    expect(
      await statusOf(service.releaseReserve(actorWith(5), { ...body, reason: undefined }, REQUEST)),
    ).toBe('400 validation_failed');
    const view = await service.releaseReserve(actorWith(5), body, REQUEST);
    expect(view.pools.find((p) => p.pool === 'customers')?.capMicroUsd).toBe(65 * USD);
    expect(rows.get('reserve')?.capMicroUsd).toBe(10 * USD);
    expect(
      await statusOf(service.releaseReserve(actorWith(5), { ...body, amountCents: 1001 }, REQUEST)),
    ).toBe('409 ai_reserve_short');
    expect(actions()).toEqual([AI_BUDGET_AUDIT_ACTIONS.reserveReleased]);
  });
});
