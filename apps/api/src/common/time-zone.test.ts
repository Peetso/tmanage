import { describe, expect, it } from 'vitest';
import { isIanaTimeZone } from './time-zone.js';

describe('isIanaTimeZone (R9: every country)', () => {
  it('accepts any real zone, not a short allow-list', () => {
    for (const zone of ['UTC', 'Africa/Cairo', 'Asia/Riyadh', 'Pacific/Chatham', 'Asia/Kolkata']) {
      expect(isIanaTimeZone(zone), zone).toBe(true);
    }
  });

  it('refuses what is not a zone', () => {
    for (const value of ['', 'Mars/Phobos', '+03:00', 'x'.repeat(65), 42, null, undefined]) {
      expect(isIanaTimeZone(value), String(value)).toBe(false);
    }
  });
});
