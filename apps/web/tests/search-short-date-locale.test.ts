import { describe, expect, it } from 'vitest';
import { shortDate } from '../src/components/screens/SearchScreen';

/** C1: an Arabic search hit's date reads the Arabic month (Latin digits, AR-DIGITS), never "Nov 2". */
describe('search hit short date', () => {
  it('follows the active locale', () => {
    expect(shortDate('2026-11-02T12:00:00.000Z', 'en')).toBe('2 Nov');
    const arabic = shortDate('2026-11-02T12:00:00.000Z', 'ar-EG');
    expect(arabic).not.toMatch(/[A-Za-z]/);
    expect(arabic).toBe('2 نوفمبر');
  });
});
