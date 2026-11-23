import { describe, expect, it } from 'vitest';
import { appDateLocale } from '../src/lib/i18n/app-locale';
import { countNoun } from '../src/lib/i18n/plural';

/** FIX4 item 8 — Arabic dates and counts. */
describe('FIX4 Arabic dates and counts', () => {
  it('draws calendar and chat dates in Arabic, with Latin digits', () => {
    expect(appDateLocale('ar-EG')).toBe('ar-EG-u-nu-latn');
    const day = new Intl.DateTimeFormat(appDateLocale('ar'), { weekday: 'short' }).format(
      new Date(Date.UTC(2026, 10, 2, 12)),
    );
    expect(day).toMatch(/[\u0600-\u06FF]/u);
    const stamp = new Intl.DateTimeFormat(appDateLocale('ar', 'en-US'), {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(2026, 9, 31, 23, 30)));
    expect(stamp).not.toMatch(/Oct/u);
    expect(stamp).toMatch(/31/u);
    expect(stamp).toMatch(/23:30/u);
    expect(appDateLocale('en-US')).toBe('en-GB');
    expect(appDateLocale('en-US', 'en-US')).toBe('en-US');
    expect(appDateLocale('fr')).toBe('fr');
  });

  it('puts the right Arabic noun after a count', () => {
    const noun = (n: number) => countNoun('ar', n, 'مهمة', 'مهام');
    expect(noun(0)).toBe('مهمة');
    expect(noun(1)).toBe('مهمة');
    expect(noun(3)).toBe('مهام');
    expect(noun(10)).toBe('مهام');
    expect(noun(15)).toBe('مهمة');
    expect(countNoun('en', 0, 'item', 'items')).toBe('items');
    expect(countNoun('en', 1, 'item', 'items')).toBe('item');
  });
});
