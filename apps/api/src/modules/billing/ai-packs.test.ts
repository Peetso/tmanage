import { describe, expect, it } from 'vitest';
import {
  AI_PACK_LIFETIME_MONTHS,
  creditsShort,
  packBalance,
  packExpiresAt,
  planDraw,
  planReturn,
  unusedPackCredits,
  type LivePack,
  type PeriodDraw,
} from './ai-packs.js';
import { AI_PACKS_SQL } from './ai-packs.repository.js';

/**
 * 62-07 (plan 62 §5) — the pack rules: 6-month expiry, allowance before packs, the oldest pack
 * first, all-or-nothing draws, unused credits back to the newest live pack, and the SQL predicates
 * that hold them on the rows (the database suite runs them on MariaDB in the test phase).
 */

const NOW = new Date('2026-11-20T10:00:00.000Z');

function pack(id: string, remaining: number, granted: string, expires = '2027-05-01'): LivePack {
  return {
    id,
    remainingCredits: remaining,
    grantedAt: new Date(`${granted}T00:00:00.000Z`),
    expiresAt: new Date(`${expires}T00:00:00.000Z`),
  };
}

describe('packExpiresAt — 6 months after the grant', () => {
  it.each([
    ['2026-11-20T10:00:00.000Z', '2027-05-20T10:00:00.000Z'],
    ['2026-08-31T23:59:59.999Z', '2027-02-28T23:59:59.999Z'], // no 31 February
    ['2027-08-31T00:00:00.000Z', '2028-02-29T00:00:00.000Z'], // leap year
    ['2026-07-15T00:00:00.000Z', '2027-01-15T00:00:00.000Z'], // across the year
  ])('%s → %s', (granted, expires) => {
    expect(packExpiresAt(new Date(granted)).toISOString()).toBe(expires);
  });

  it('is the plan figure', () => {
    expect(AI_PACK_LIFETIME_MONTHS).toBe(6);
  });
});

describe('allowance first, then the oldest pack', () => {
  const period = { allowanceCredits: 100, packCredits: 0, settledCredits: 90, reservedCredits: 5 };

  it('asks the packs only for what the allowance and moved credits cannot cover', () => {
    expect(creditsShort(period, 5)).toBe(0);
    expect(creditsShort(period, 30)).toBe(25);
    expect(creditsShort({ ...period, packCredits: 20 }, 30)).toBe(5);
  });

  it('draws oldest grant first, across packs, exactly the need', () => {
    const packs = [
      pack('b', 10, '2026-10-02'),
      pack('a', 4, '2026-10-01'),
      pack('c', 50, '2026-11-01'),
    ];
    expect(planDraw(packs, 12, NOW)).toEqual([
      { packId: 'a', credits: 4 },
      { packId: 'b', credits: 8 },
    ]);
    expect(planDraw(packs, 0, NOW)).toEqual([]);
  });

  it('never draws an expired or empty pack, and takes nothing when the packs are short', () => {
    const packs = [
      pack('old', 100, '2026-01-01', '2026-07-01'), // expired
      pack('empty', 0, '2026-09-01'),
      pack('live', 10, '2026-10-01'),
    ];
    expect(planDraw(packs, 10, NOW)).toEqual([{ packId: 'live', credits: 10 }]);
    expect(planDraw(packs, 11, NOW)).toBeNull();
  });

  it('breaks a same-time grant tie by id, so two runs draw the same pack', () => {
    const packs = [pack('y', 5, '2026-10-01'), pack('x', 5, '2026-10-01')];
    expect(planDraw(packs, 3, NOW)).toEqual([{ packId: 'x', credits: 3 }]);
  });
});

describe('unused pack credits of a closed period go back, newest first', () => {
  it('counts the allowance as spent first and never returns more than was moved in', () => {
    const base = {
      allowanceCredits: 100,
      packCredits: 50,
      settledCredits: 120,
      reservedCredits: 0,
    };
    expect(unusedPackCredits(base)).toBe(30);
    expect(unusedPackCredits({ ...base, settledCredits: 40 })).toBe(50);
    expect(unusedPackCredits({ ...base, settledCredits: 160 })).toBe(0);
  });

  it('returns to the newest live pack first; an expired pack keeps nothing', () => {
    const draws: PeriodDraw[] = [
      { ...pack('old', 0, '2026-09-01'), drawnCredits: 20 },
      { ...pack('new', 5, '2026-10-01'), drawnCredits: 15 },
    ];
    expect(planReturn(draws, 25, NOW)).toEqual([
      { packId: 'new', credits: 15 },
      { packId: 'old', credits: 10 },
    ]);
    const expiredNewest: PeriodDraw[] = [
      { ...pack('old', 0, '2026-09-01'), drawnCredits: 20 },
      { ...pack('new', 0, '2026-10-01', '2026-11-15'), drawnCredits: 15 },
    ];
    expect(planReturn(expiredNewest, 25, NOW)).toEqual([{ packId: 'old', credits: 10 }]);
    expect(planReturn(draws, 0, NOW)).toEqual([]);
  });

  it('sums only the live packs into the balance', () => {
    expect(
      packBalance([pack('a', 10, '2026-10-01'), pack('b', 7, '2026-01-01', '2026-07-01')], NOW),
    ).toBe(10);
  });
});

describe('the pack SQL carries each rule in its WHERE', () => {
  it('a pack never goes below 0, above its size, or moves once expired', () => {
    expect(AI_PACKS_SQL.drawPack).toContain('remaining_credits >= ?');
    expect(AI_PACKS_SQL.drawPack).toContain('expires_at > ?');
    expect(AI_PACKS_SQL.returnPack).toContain('remaining_credits + ? <= size_credits');
    expect(AI_PACKS_SQL.returnPack).toContain('expires_at > ?');
  });

  it('locks period then packs, oldest grant first; a closed period only once and with no hold open', () => {
    expect(AI_PACKS_SQL.lockPeriod).toMatch(/for update$/);
    expect(AI_PACKS_SQL.lockLivePacks).toMatch(/order by granted_at, id for update$/);
    expect(AI_PACKS_SQL.closedPeriods).toContain(
      'pack_returned_at is null and reserved_credits = 0',
    );
    expect(AI_PACKS_SQL.markReturned).toContain('and pack_returned_at is null');
  });

  it('one open request per workspace; a decision only from open', () => {
    expect(AI_PACKS_SQL.insertRequest).toContain("'open', 1");
    expect(AI_PACKS_SQL.decideRequest).toContain('open_slot = null');
    expect(AI_PACKS_SQL.decideRequest).toContain("and status = 'open'");
  });

  it('binds every tenant statement to the organization', () => {
    const platformReads = new Set(['testList', 'openRequests', 'organization']);
    for (const [name, sql] of Object.entries(AI_PACKS_SQL)) {
      if (platformReads.has(name)) continue;
      if (/^insert\b/.test(sql)) {
        // An insert carries the tenant as its first column instead of a WHERE.
        expect(sql, name).toMatch(/\(id, organization_id,/);
        continue;
      }
      expect(sql, name).toMatch(/organization_id = \?/);
    }
    expect(AI_PACKS_SQL.organization).toContain('where id = ?');
  });
});
