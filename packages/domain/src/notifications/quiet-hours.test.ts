import { describe, expect, it } from 'vitest';
import {
  eventTypeBypassesQuietHours,
  isInQuietHours,
  isValidTimeZone,
  quietHoursResumeAt,
} from './quiet-hours.js';
import type { QuietHoursPreferences } from './quiet-hours.js';

/**
 * INBOX-001 quiet hours — the pure decision, the four cases the brief names plus the urgent
 * bypass and the resume-time the delivery seam defers to.
 */

const prefs = (
  start: string | null,
  end: string | null,
  timeZone: string | null,
): QuietHoursPreferences => ({
  quietHoursStart: start,
  quietHoursEnd: end,
  quietHoursTimezone: timeZone,
});

describe('isInQuietHours', () => {
  it('a window inside a day is the plain between, half-open at the end', () => {
    const window = prefs('09:00', '17:00', 'UTC');
    expect(isInQuietHours(new Date('2026-06-15T12:00:00Z'), window)).toBe(true);
    expect(isInQuietHours(new Date('2026-06-15T09:00:00Z'), window)).toBe(true);
    expect(isInQuietHours(new Date('2026-06-15T08:59:59Z'), window)).toBe(false);
    expect(isInQuietHours(new Date('2026-06-15T17:00:00Z'), window)).toBe(false);
  });

  it('a window crossing midnight is inside at or past the start, or before the end', () => {
    const window = prefs('22:00', '07:00', 'UTC');
    expect(isInQuietHours(new Date('2026-06-15T23:30:00Z'), window)).toBe(true);
    expect(isInQuietHours(new Date('2026-06-15T06:59:00Z'), window)).toBe(true);
    expect(isInQuietHours(new Date('2026-06-15T22:00:00Z'), window)).toBe(true);
    expect(isInQuietHours(new Date('2026-06-15T07:00:00Z'), window)).toBe(false);
    expect(isInQuietHours(new Date('2026-06-15T12:00:00Z'), window)).toBe(false);
  });

  it('reads the clock in the recipient IANA zone, not UTC', () => {
    // America/New_York is UTC-4 on this June instant. 03:00Z is 23:00 local — inside a
    // 22:00–07:00 window; 12:00Z is 08:00 local — outside it.
    const window = prefs('22:00', '07:00', 'America/New_York');
    expect(isInQuietHours(new Date('2026-06-15T03:00:00Z'), window)).toBe(true);
    expect(isInQuietHours(new Date('2026-06-15T12:00:00Z'), window)).toBe(false);
  });

  it('is false when there is no usable window', () => {
    const now = new Date('2026-06-15T23:30:00Z');
    expect(isInQuietHours(now, null)).toBe(false);
    expect(isInQuietHours(now, prefs('22:00', '07:00', null))).toBe(false);
    expect(isInQuietHours(now, prefs('22:00', null, 'UTC'))).toBe(false);
    expect(isInQuietHours(now, prefs('08:00', '08:00', 'UTC'))).toBe(false); // zero-length
    expect(isInQuietHours(now, prefs('22:00', '07:00', 'Mars/Phobos'))).toBe(false);
  });
});

describe('eventTypeBypassesQuietHours', () => {
  it('exempts the 24-EVENT-CATALOG yes-critical kinds and no others', () => {
    expect(eventTypeBypassesQuietHours('approval.decided.v1')).toBe(true);
    expect(eventTypeBypassesQuietHours('membership.suspended.v1')).toBe(true);
    expect(eventTypeBypassesQuietHours('client_request.submitted.v1')).toBe(false);
    expect(eventTypeBypassesQuietHours('work_item.blocked.v1')).toBe(false);
  });
});

describe('isValidTimeZone', () => {
  it('accepts real IANA zones and rejects the rest', () => {
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Europe/London')).toBe(true);
    expect(isValidTimeZone('Mars/Phobos')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});

describe('quietHoursResumeAt', () => {
  it('is the window end for a delivery deferred inside the window', () => {
    const window = prefs('09:00', '17:00', 'UTC');
    expect(quietHoursResumeAt(new Date('2026-06-15T12:00:00Z'), window)).toEqual(
      new Date('2026-06-15T17:00:00Z'),
    );
  });

  it('wraps past midnight for a cross-midnight window', () => {
    const window = prefs('22:00', '07:00', 'UTC');
    expect(quietHoursResumeAt(new Date('2026-06-15T23:00:00Z'), window)).toEqual(
      new Date('2026-06-16T07:00:00Z'),
    );
  });

  it('is null when nothing is deferred (not in the window)', () => {
    expect(
      quietHoursResumeAt(new Date('2026-06-15T12:00:00Z'), prefs('22:00', '07:00', 'UTC')),
    ).toBe(null);
    expect(quietHoursResumeAt(new Date('2026-06-15T12:00:00Z'), null)).toBe(null);
  });
});
