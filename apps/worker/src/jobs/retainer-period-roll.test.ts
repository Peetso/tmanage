import { describe, expect, it } from 'vitest';
import { localDateOf } from '@tmanage/domain';
import { decideRetainerRoll, retainerPeriodBounds } from './retainer-period-roll.js';

/** INT-52-13 (pure half): the roll is due on the org's own midnight and rolls over what was left. */

const reading = {
  state: 'active',
  period: 'monthly' as const,
  startsOn: '2026-01-31',
  endsOn: null,
  hoursPerPeriod: 40,
  rollover: 'cap',
  rolloverCapMinutes: 600,
  periodStart: '2026-10-31',
  periodEnd: '2026-11-29',
  allowanceMinutes: 2400,
  rolloverInMinutes: 0,
  usedMinutes: 1500,
};

describe('retainer period roll', () => {
  it('is due in Riyadh at 00:30 on the next day while UTC is still on the last day', () => {
    const at = new Date('2026-11-29T21:30:00Z');
    expect(decideRetainerRoll({ ...reading, today: localDateOf(at, 'UTC') }).close).toBe(false);
    const riyadh = decideRetainerRoll({ ...reading, today: localDateOf(at, 'Asia/Riyadh') });
    expect(riyadh.close).toBe(true);
    expect(riyadh.next).toEqual({
      periodStart: '2026-11-30',
      periodEnd: '2026-12-30',
      allowanceMinutes: 2400,
      rolloverInMinutes: 600,
    });
  });

  it('does not roll a paused retainer and opens nothing after an ended one', () => {
    const today = '2026-12-05';
    expect(decideRetainerRoll({ ...reading, state: 'paused', today }).close).toBe(false);
    expect(decideRetainerRoll({ ...reading, state: 'ended', today })).toMatchObject({
      close: true,
      next: null,
    });
    expect(retainerPeriodBounds('2026-01-31', 'monthly', 1).periodStart).toBe('2026-02-28');
  });
});
