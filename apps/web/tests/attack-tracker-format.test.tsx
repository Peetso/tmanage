import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useTrackerFormat } from '../src/components/platform/security/tracker-format';
import { displayFormat } from '../src/lib/i18n/display-format';
import { activeLocale } from '../src/lib/i18n/locale-store';

/** SEC-TRACKER — Arabic counts, times and dates keep Latin digits (Figma 840:906). */

const AT = '2026-11-22T11:42:00.000Z';

afterEach(() => {
  activeLocale.set('en-US');
  displayFormat.set({});
});

describe('Attack tracker digits', () => {
  it('writes Arabic counts, times and days in Latin digits when nothing is saved', () => {
    activeLocale.set('ar-EG');
    const { result } = renderHook(() => useTrackerFormat());
    const written = [
      result.current.count(333),
      result.current.time(AT),
      result.current.day(AT),
      result.current.dayTime(AT),
    ].join(' ');
    expect(written).toMatch(/333/u);
    expect(written).toMatch(/22/u);
    expect(written).not.toMatch(/[٠-٩]/u);
  });

  it('keeps a member who saved Arabic-Indic digits on them', () => {
    activeLocale.set('ar-EG');
    displayFormat.set({ numerals: 'arabic_indic' });
    const { result } = renderHook(() => useTrackerFormat());
    expect(result.current.count(333)).toBe('٣٣٣');
  });

  it('writes English days day-first, as Figma ("22 Nov 11:42")', () => {
    activeLocale.set('en-US');
    const { result } = renderHook(() => useTrackerFormat());
    expect(result.current.count(1234)).toBe('1,234');
    expect(result.current.day(AT)).toMatch(/^22 Nov$/u);
  });
});
