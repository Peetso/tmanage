import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dateFromDriver } from './drizzle.js';

/**
 * TESTUX P1 14: a `DATETIME(3)` selected through Drizzle as a raw `sql` expression arrives as
 * zone-less UTC text. Read in the process's zone, it moved "Last active" two hours back on a
 * machine in Cairo. The process here is put east of UTC so a local-time read would fail.
 */
describe('dateFromDriver', () => {
  let zone: string | undefined;
  beforeEach(() => {
    zone = process.env['TZ'];
    process.env['TZ'] = 'Africa/Cairo';
  });
  afterEach(() => {
    if (zone === undefined) delete process.env['TZ'];
    else process.env['TZ'] = zone;
  });

  it('reads the zone-less driver text as UTC', () => {
    expect(dateFromDriver('2026-11-18 10:00:00.000')?.toISOString()).toBe(
      '2026-11-18T10:00:00.000Z',
    );
  });

  it('keeps a Date and an ISO string as they are, and answers null for none or garbage', () => {
    const at = new Date('2026-11-18T10:00:00.000Z');
    expect(dateFromDriver(at)).toBe(at);
    expect(dateFromDriver('2026-11-18T10:00:00.000Z')?.toISOString()).toBe(at.toISOString());
    expect(dateFromDriver(null)).toBeNull();
    expect(dateFromDriver(undefined)).toBeNull();
    expect(dateFromDriver('not a date')).toBeNull();
  });
});
