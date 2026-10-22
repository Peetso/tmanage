import { afterEach, describe, expect, it } from 'vitest';
import {
  dayToInstant,
  formatDay,
  formatInstant,
  instantToDay,
} from '../src/lib/work-item-presentation';
import { activeLocale, DEFAULT_LOCALE } from '../src/lib/i18n/locale-store';

/**
 * WRK-13 — the work item reads its dates in the member's saved language, through the one shared
 * `format.ts` wrapper, rather than `Intl.…Format(undefined, …)` (the browser's locale, Latin
 * digits that scramble against Arabic). The pure presentation helpers read the active locale from
 * the store, so a plain call site like `formatDay(item.dueAt)` now follows the account.
 */
afterEach(() => {
  activeLocale.set(DEFAULT_LOCALE);
});

describe('work item dates follow the active locale (WRK-13)', () => {
  it('reads a missing date as words, not an empty or invalid cell', () => {
    expect(formatDay(null)).toBe('No date');
    expect(formatInstant(null)).toBe('No date');
  });

  it('formats a bare calendar day in the member locale — Arabic-Indic digits for ar-EG', () => {
    activeLocale.set('en-US');
    const en = formatDay('2026-01-15');
    expect(en).toMatch(/15/);
    expect(en).not.toMatch(/[٠-٩]/u);

    activeLocale.set('ar-EG');
    const ar = formatDay('2026-01-15');
    // Arabic-Indic digits (U+0660–U+0669), never ASCII — the RTL scramble is gone.
    expect(ar).toMatch(/[٠-٩]/u);
    expect(ar).not.toMatch(/[0-9]/u);
    expect(ar).not.toBe(en);
  });

  it('formats a full instant in the member locale rather than the browser default', () => {
    activeLocale.set('ar-EG');
    expect(formatInstant('2026-01-15T13:45:00.000Z')).toMatch(/[٠-٩]/u);
  });

  it('round-trips a picked day through the stored instant (P9 date picker)', () => {
    expect(dayToInstant('2026-09-20')).toBe('2026-09-20T12:00:00.000Z');
    expect(dayToInstant('')).toBeNull();
    expect(instantToDay('2026-09-20T12:00:00.000Z')).toBe('2026-09-20');
    expect(instantToDay(null)).toBe('');
  });

  it('returns an unparseable value verbatim rather than crashing the render', () => {
    expect(formatDay('nope')).toBe('nope');
    expect(formatInstant('nope')).toBe('nope');
  });
});
