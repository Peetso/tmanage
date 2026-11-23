import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIME_TRUST_POLICY,
  entryCounts,
  handTimeRefusal,
  isIdleCapHours,
  timeTrustOf,
  trustTotals,
  type CountedFacts,
} from './trust.js';

const facts = (over: Partial<CountedFacts>): CountedFacts => ({
  source: 'timer',
  approvalState: 'none',
  needsReview: false,
  supersededBy: null,
  ...over,
});

describe('time trust (owner rule 2026-11-23)', () => {
  it('defaults: hand time off, counts only after approval, 10 h cap', () => {
    expect(DEFAULT_TIME_TRUST_POLICY).toEqual({
      handTimeAllowed: false,
      handTimeCountMode: 'after_approval',
      idleCapHours: 10,
    });
  });

  it('only server-stamped sources are measured', () => {
    expect(timeTrustOf('timer')).toBe('measured');
    expect(timeTrustOf('automatic')).toBe('measured');
    expect(timeTrustOf('manual')).toBe('hand');
    expect(timeTrustOf('correction')).toBe('hand');
    expect(timeTrustOf('anything-else')).toBe('hand');
  });

  it.each([
    // [facts, mode, counts]
    [facts({}), 'after_approval', true],
    [facts({ needsReview: true }), 'after_approval', false],
    [facts({ needsReview: true, approvalState: 'approved' }), 'after_approval', true],
    [facts({ supersededBy: 'c1' }), 'after_approval', false],
    [facts({ source: 'manual', approvalState: 'pending' }), 'after_approval', false],
    [facts({ source: 'manual', approvalState: 'pending' }), 'at_once_flagged', true],
    [facts({ source: 'manual', approvalState: 'approved' }), 'after_approval', true],
    [facts({ source: 'manual', approvalState: 'rejected' }), 'at_once_flagged', false],
    [facts({ source: 'manual', approvalState: 'none' }), 'after_approval', true],
    [facts({ source: 'correction', approvalState: 'pending' }), 'at_once_flagged', false],
    [facts({ source: 'correction', approvalState: 'approved' }), 'after_approval', true],
  ] as const)('entryCounts(%o, %s) = %s', (f, mode, expected) => {
    expect(entryCounts(f, mode)).toBe(expected);
  });

  it('splits counted minutes into measured and hand; pending is reported apart', () => {
    expect(
      trustTotals([
        { minutes: 60, source: 'timer', counted: true, approvalState: 'none' },
        { minutes: 30, source: 'automatic', counted: true, approvalState: 'none' },
        { minutes: 20, source: 'manual', counted: true, approvalState: 'approved' },
        { minutes: 15, source: 'manual', counted: false, approvalState: 'pending' },
        { minutes: 10, source: 'correction', counted: false, approvalState: 'rejected' },
      ]),
    ).toEqual({ measuredMinutes: 90, handMinutes: 20, pendingMinutes: 15 });
  });

  it('refuses hand time when the owner turned it off, and without a reason', () => {
    expect(handTimeRefusal({ handTimeAllowed: false }, 'met the client')).toBe('hand_time_off');
    expect(handTimeRefusal({ handTimeAllowed: true }, null)).toBe('reason_required');
    expect(handTimeRefusal({ handTimeAllowed: true }, '  a ')).toBe('reason_required');
    expect(handTimeRefusal({ handTimeAllowed: true }, 'met the client')).toBeNull();
  });

  it('bounds the idle cap to 4..24 whole hours', () => {
    expect([3, 4, 10, 24, 25, 4.5, '10'].map(isIdleCapHours)).toEqual([
      false,
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
  });
});
