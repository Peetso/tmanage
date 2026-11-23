import { describe, expect, it } from 'vitest';
import { formatMailDate } from './privacy-mailer.js';

/** AR-DIGITS: the Arabic privacy mails write dates with Latin digits, like the app and the catalog. */
describe('formatMailDate', () => {
  const at = new Date('2026-11-23T10:00:00.000Z');

  it('writes the Arabic date with Arabic month words and Latin digits', () => {
    const arabic = formatMailDate(at, true);
    expect(arabic).toMatch(/23/u);
    expect(arabic).toMatch(/2026/u);
    expect(arabic).toMatch(/نوفمبر/u);
    expect(arabic).not.toMatch(/[٠-٩]/u);
  });

  it('keeps the English date as before', () => {
    expect(formatMailDate(at, false)).toBe('23 November 2026');
  });
});
