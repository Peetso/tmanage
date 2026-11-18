import { describe, expect, it } from 'vitest';
import { arabicMinutes } from './arabic-minutes.js';

describe('arabicMinutes', () => {
  it('uses the Arabic plural form for each count', () => {
    expect(arabicMinutes(1)).toBe('دقيقة واحدة');
    expect(arabicMinutes(2)).toBe('دقيقتين');
    expect(arabicMinutes(3)).toBe('3 دقائق');
    expect(arabicMinutes(10)).toBe('10 دقائق');
    expect(arabicMinutes(15)).toBe('15 دقيقة');
  });
});
