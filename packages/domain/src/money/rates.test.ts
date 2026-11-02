import { describe, expect, it } from 'vitest';
import { rateWindowsOverlap, resolveRate } from './rates.js';
import type { RateCardInput, RateEntryInput } from './rates.js';

const e = (
  targetType: RateEntryInput['targetType'],
  targetKey: string | null,
  hourlyMinor: number,
  effectiveFrom = '2026-01-01',
  effectiveTo: string | null = null,
): RateEntryInput => ({ targetType, targetKey, hourlyMinor, effectiveFrom, effectiveTo });

const card = (
  id: string,
  scope: RateCardInput['scope'],
  scopeId: string | null,
  entries: RateEntryInput[],
): RateCardInput => ({ id, scope, scopeId, currency: 'SAR', archived: false, entries });

describe('UNIT-52-07 resolveRate', () => {
  const org = card('org', 'org', null, [
    e('default', null, 20_000, '2026-01-01', '2026-07-01'),
    e('default', null, 25_000, '2026-07-01'),
    e('role', 'manager', 30_000),
    e('membership', 'm1', 35_000),
  ]);
  const client = card('cl', 'client', 'c1', [e('role', 'manager', 40_000)]);
  const project = card('pr', 'project', 'p1', [e('default', null, 50_000)]);
  const q = {
    projectId: 'p9',
    clientOrgId: null,
    membershipId: 'm2',
    role: 'member',
    on: '2026-06-30',
  };

  it('walks project → client → membership → role → default, with effective windows', () => {
    const cards = [org, client, project];
    expect(resolveRate(cards, { ...q, projectId: 'p1' })?.source).toBe('project');
    expect(resolveRate(cards, { ...q, clientOrgId: 'c1', role: 'manager' })).toMatchObject({
      hourlyMinor: 40_000,
      source: 'client',
    });
    expect(resolveRate(cards, { ...q, clientOrgId: 'c1', membershipId: 'm1' })?.source).toBe(
      'membership',
    );
    expect(resolveRate(cards, { ...q, role: 'manager' })?.hourlyMinor).toBe(30_000);
    expect(resolveRate(cards, q)?.hourlyMinor).toBe(20_000);
    expect(resolveRate(cards, { ...q, on: '2026-07-01' })?.hourlyMinor).toBe(25_000);
    expect(resolveRate(cards, { ...q, on: '2025-12-31' })).toBeNull();
    expect(resolveRate([{ ...org, archived: true }], q)).toBeNull();
    expect(resolveRate(cards, { ...q, projectRateCardId: 'cl', role: 'manager' })?.source).toBe(
      'project',
    );
    expect(
      rateWindowsOverlap(
        e('default', null, 1, '2026-01-01', '2026-07-01'),
        e('default', null, 1, '2026-07-01'),
      ),
    ).toBe(false);
    expect(
      rateWindowsOverlap(e('default', null, 1, '2026-01-01'), e('default', null, 1, '2027-01-01')),
    ).toBe(true);
  });
});
