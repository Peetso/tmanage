import { describe, expect, it } from 'vitest';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import {
  createTenantContext,
  type TenantContext,
  type TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { ApiError } from '../../common/http/errors.js';
import type { AiWorkspaceAllowance } from './ai-allowance.service.js';
import type { LivePack } from './ai-packs.js';
import type {
  AiPackRequestRecord,
  AiPacksRepository,
  AiWorkspacePlatformSettings,
  PeriodRow,
} from './ai-packs.repository.js';
import { AI_PACK_REQUESTED_AUDIT_ACTION, AiPacksService } from './ai-packs.service.js';

/**
 * 62-07 (plan 62 §5) — the pack service on an in-memory repository that applies each statement's
 * predicate the way its SQL does (`ai-packs.test.ts` pins the SQL). The races, the lock order and
 * tenant isolation on MariaDB are the database suite's (`test/t-62-07-ai-packs.db.test.ts`, test
 * phase).
 */

const RUNNER = {} as TenantQueryRunner;
const NOW = new Date('2026-11-20T10:00:00.000Z');
const PERIOD = '2026-11-01';

interface Move {
  packId: string;
  periodStart: string;
  direction: 'draw' | 'return';
  credits: number;
}

class FakeRepository {
  periods = new Map<string, PeriodRow & { returned: boolean }>();
  packs = new Map<string, LivePack & { size: number }>();
  moves: Move[] = [];
  requests: (AiPackRequestRecord & { open: boolean })[] = [];
  settingsValue: AiWorkspacePlatformSettings = {
    onTestList: true,
    testListAt: NOW,
    poolClass: 'customers',
    memberSharePercent: 50,
  };

  async settings() {
    return this.settingsValue;
  }
  async lockPeriod(_t: unknown, _c: unknown, period: string) {
    return this.periods.get(period) ?? null;
  }
  async readPeriod(_t: unknown, _c: unknown, period: string) {
    return this.periods.get(period) ?? null;
  }
  async addPackCredits(_t: unknown, _c: unknown, period: string, credits: number) {
    const row = this.periods.get(period);
    if (!row) return false;
    this.periods.set(period, { ...row, packCredits: row.packCredits + credits });
    return true;
  }
  async lockClosedPeriodsWithPackCredits(_t: unknown, _c: unknown, before: string) {
    return [...this.periods.values()]
      .filter(
        (p) =>
          p.periodStart < before && p.packCredits > 0 && !p.returned && p.reservedCredits === 0,
      )
      .sort((a, b) => (a.periodStart < b.periodStart ? -1 : 1));
  }
  async markReturned(_t: unknown, _c: unknown, period: string) {
    const row = this.periods.get(period);
    if (!row || row.returned) return false;
    this.periods.set(period, { ...row, returned: true });
    return true;
  }
  live(now: Date) {
    return [...this.packs.values()]
      .filter((p) => p.remainingCredits > 0 && p.expiresAt > now)
      .sort((a, b) => a.grantedAt.getTime() - b.grantedAt.getTime());
  }
  async livePacks(_t: unknown, _c: unknown, now: Date) {
    return this.live(now);
  }
  async lockLivePacks(_t: unknown, _c: unknown, now: Date) {
    return this.live(now);
  }
  async drawFromPack(_t: unknown, _c: unknown, id: string, credits: number, now: Date) {
    const p = this.packs.get(id);
    if (!p || p.remainingCredits < credits || p.expiresAt <= now) return false;
    this.packs.set(id, { ...p, remainingCredits: p.remainingCredits - credits });
    return true;
  }
  async returnToPack(_t: unknown, _c: unknown, id: string, credits: number, now: Date) {
    const p = this.packs.get(id);
    if (!p || p.expiresAt <= now || p.remainingCredits + credits > p.size) return false;
    this.packs.set(id, { ...p, remainingCredits: p.remainingCredits + credits });
    return true;
  }
  async insertMove(_t: unknown, _c: unknown, move: Move) {
    this.moves.push({
      packId: move.packId,
      periodStart: move.periodStart,
      direction: move.direction,
      credits: move.credits,
    });
  }
  async periodDraws(_t: unknown, _c: unknown, period: string) {
    const drawn = new Map<string, number>();
    for (const m of this.moves) {
      if (m.periodStart === period && m.direction === 'draw') {
        drawn.set(m.packId, (drawn.get(m.packId) ?? 0) + m.credits);
      }
    }
    return [...drawn].map(([id, credits]) => ({ ...this.packs.get(id)!, drawnCredits: credits }));
  }
  async openRequest() {
    return this.requests.find((r) => r.open) ?? null;
  }
  async insertRequest(
    _t: unknown,
    _c: unknown,
    input: { id: string; membershipId: string; now: Date },
  ) {
    if (this.requests.some((r) => r.open)) {
      throw Object.assign(new Error('Duplicate entry'), { errno: 1062, code: 'ER_DUP_ENTRY' });
    }
    this.requests.push({
      id: input.id,
      status: 'open',
      requestedByMembershipId: input.membershipId,
      requestedAt: input.now,
      decidedAt: null,
      packId: null,
      open: true,
    });
  }

  addPack(
    id: string,
    remaining: number,
    granted: string,
    expires = '2027-05-01',
    size = remaining,
  ) {
    this.packs.set(id, {
      id,
      size,
      remainingCredits: remaining,
      grantedAt: new Date(`${granted}T00:00:00.000Z`),
      expiresAt: new Date(`${expires}T00:00:00.000Z`),
    });
  }
  addPeriod(row: Partial<PeriodRow> & { periodStart: string }) {
    this.periods.set(row.periodStart, {
      allowanceCredits: 0,
      packCredits: 0,
      settledCredits: 0,
      reservedCredits: 0,
      ...row,
      returned: false,
    });
  }
}

function owner(role: 'owner' | 'member' = 'owner'): TenantContext {
  return createTenantContext({
    organizationId: uuidv7(),
    userId: uuidv7(),
    principalKind: 'internal',
    membershipId: uuidv7(),
    capabilities: capabilitiesFor(role),
    policyVersion: 'v1',
    correlationId: uuidv7(),
  });
}

function setup() {
  const repo = new FakeRepository();
  const audits: { action: string; metadata: unknown }[] = [];
  const allowance = (period: PeriodRow | null): AiWorkspaceAllowance => ({
    settings: repo.settingsValue,
    periodStart: PERIOD,
    allowanceCredits: 1000,
    limitedBy: 'plan',
    raisedBySupport: false,
    period,
    livePacks: repo.live(NOW),
    packBalanceCredits: repo.live(NOW).reduce((s, p) => s + p.remainingCredits, 0),
    memberCredits: 500,
  });
  const service = new AiPacksService({
    database: {
      read: async (_c, work) => work(RUNNER),
      transaction: async (_c, work) => work(RUNNER),
    },
    allowance: {
      resolveWith: async () => allowance(repo.periods.get(PERIOD) ?? null),
    },
    audit: {
      record: async (_tx, _ctx, input) => {
        audits.push({ action: input.action, metadata: input.metadata });
        return {} as never;
      },
    },
    repository: repo as unknown as AiPacksRepository,
    now: () => NOW,
  });
  return { repo, service, audits };
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

describe('topUp — the budget port', () => {
  it('moves nothing while the allowance covers the hold', async () => {
    const { repo, service } = setup();
    repo.addPeriod({ periodStart: PERIOD, allowanceCredits: 100, settledCredits: 50 });
    repo.addPack('p', 100, '2026-10-01');
    expect(await service.topUp(RUNNER, owner(), PERIOD, 30, NOW)).toBe(true);
    expect(repo.moves).toEqual([]);
    expect(repo.packs.get('p')?.remainingCredits).toBe(100);
  });

  it('moves exactly what is short, oldest pack first, and records every move', async () => {
    const { repo, service } = setup();
    repo.addPeriod({ periodStart: PERIOD, allowanceCredits: 100, settledCredits: 95 });
    repo.addPack('newer', 50, '2026-11-01');
    repo.addPack('older', 3, '2026-10-01');
    expect(await service.topUp(RUNNER, owner(), PERIOD, 30, NOW)).toBe(true);
    expect(repo.moves).toEqual([
      { packId: 'older', periodStart: PERIOD, direction: 'draw', credits: 3 },
      { packId: 'newer', periodStart: PERIOD, direction: 'draw', credits: 22 },
    ]);
    expect(repo.periods.get(PERIOD)?.packCredits).toBe(25);
    expect(repo.packs.get('older')?.remainingCredits).toBe(0);
    expect(repo.packs.get('newer')?.remainingCredits).toBe(28);
  });

  it('says no and moves nothing when the live packs hold too little (expired ones never count)', async () => {
    const { repo, service } = setup();
    repo.addPeriod({ periodStart: PERIOD, allowanceCredits: 0 });
    repo.addPack('expired', 500, '2026-01-01', '2026-07-01');
    repo.addPack('live', 4, '2026-10-01');
    expect(await service.topUp(RUNNER, owner(), PERIOD, 5, NOW)).toBe(false);
    expect(repo.moves).toEqual([]);
    expect(repo.packs.get('live')?.remainingCredits).toBe(4);
  });

  it('first gives a closed month its unused pack credits back, once', async () => {
    const { repo, service } = setup();
    repo.addPack('a', 0, '2026-09-01', '2027-03-01', 40);
    repo.addPeriod({
      periodStart: '2026-10-01',
      allowanceCredits: 100,
      packCredits: 40,
      settledCredits: 110,
    });
    repo.moves.push({ packId: 'a', periodStart: '2026-10-01', direction: 'draw', credits: 40 });
    repo.addPeriod({ periodStart: PERIOD, allowanceCredits: 100 });
    expect(await service.topUp(RUNNER, owner(), PERIOD, 5, NOW)).toBe(true);
    expect(repo.packs.get('a')?.remainingCredits).toBe(30);
    expect(repo.moves.at(-1)).toEqual({
      packId: 'a',
      periodStart: '2026-10-01',
      direction: 'return',
      credits: 30,
    });
    expect(await service.returnUnused(RUNNER, owner(), PERIOD, NOW)).toBe(0);
  });

  it('leaves a closed month with a hold still open for the expiry sweep', async () => {
    const { repo, service } = setup();
    repo.addPeriod({ periodStart: '2026-10-01', packCredits: 10, reservedCredits: 5 });
    expect(await service.returnUnused(RUNNER, owner(), PERIOD, NOW)).toBe(0);
    expect(repo.periods.get('2026-10-01')?.returned).toBe(false);
  });
});

describe('the owner routes', () => {
  it('a workspace not on the test list has no AI credits at all (404 on both routes)', async () => {
    const { repo, service } = setup();
    repo.settingsValue = { ...repo.settingsValue, onTestList: false, testListAt: null };
    expect(await status(service.credits(owner()))).toBe(404);
    expect(await status(service.requestPack(owner()))).toBe(404);
    expect(repo.requests).toEqual([]);
  });

  it('shows allowance, used, held, remaining, reset date, packs and the decision to request', async () => {
    const { repo, service } = setup();
    repo.addPeriod({
      periodStart: PERIOD,
      allowanceCredits: 1000,
      packCredits: 50,
      settledCredits: 900,
      reservedCredits: 30,
    });
    repo.addPack('p', 70, '2026-10-01');
    const view = await service.credits(owner());
    expect(view).toMatchObject({
      periodStart: PERIOD,
      resetsOn: '2026-12-01',
      allowanceCredits: 1000,
      packCreditsThisMonth: 50,
      usedCredits: 900,
      heldCredits: 30,
      remainingCredits: 120,
      packBalanceCredits: 70,
      openRequest: null,
      canRequestPack: true,
    });
    expect((await service.credits(owner('member'))).canRequestPack).toBe(false);
  });

  it('keeps one open request: the second is a 409, and the request is audited with counts only', async () => {
    const { repo, service, audits } = setup();
    const ctx = owner();
    const first = await service.requestPack(ctx);
    expect(first.status).toBe('open');
    expect(await status(service.requestPack(ctx))).toBe(409);
    expect(repo.requests).toHaveLength(1);
    expect(audits).toEqual([
      {
        action: AI_PACK_REQUESTED_AUDIT_ACTION,
        metadata: { pack_balance_credits: 0, allowance_credits: 1000 },
      },
    ]);
    expect((await service.credits(ctx)).canRequestPack).toBe(false);
  });

  it('turns the unique-key refusal of a racing second request into the same 409', async () => {
    const { repo, service } = setup();
    // The read saw no open request, but a concurrent insert won the unique open slot.
    repo.openRequest = async () => null;
    repo.requests.push({
      id: uuidv7(),
      status: 'open',
      requestedByMembershipId: uuidv7(),
      requestedAt: NOW,
      decidedAt: null,
      packId: null,
      open: true,
    });
    expect(await status(service.requestPack(owner()))).toBe(409);
  });
});
