import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findClaimViolations } from '../../../packages/domain/src/legal/public-claims';
import { COMPARE_ENTRIES } from '../src/content/compare/compare-entries';
import { ComparePage } from '../src/components/website/pages/compare/ComparePage';
import { activeLocale } from '../src/lib/i18n/locale-store';

vi.mock('next/navigation', () => ({ usePathname: () => '/compare', useRouter: () => ({}) }));
afterEach(() => (cleanup(), act(() => activeLocale.set('en-US'))));

const PRICE =
  /[$€£]|\bUSD\b|\bSAR\b|\/\s?(?:mo|month|user)|per (?:user|seat|month)|ر\.س|شهريًا للمستخدم/iu;

/** Row 57-06 — every compare page renders in both languages, dated, sourced and price-free. */
describe('compare pages', () => {
  it.each(['en-US', 'ar-EG'] as const)(
    'render every entry in %s with a date and no price',
    (loc) => {
      act(() => activeLocale.set(loc));
      for (const entry of COMPARE_ENTRIES) {
        const { container } = render(<ComparePage entry={entry} />);
        expect(screen.getByTestId('compare-last-checked').textContent).toMatch(/2026/);
        expect(container.textContent ?? '', entry.slug).not.toMatch(PRICE);
        expect(container.querySelector(`a[href="${entry.pricingUrl}"]`)).not.toBeNull();
        cleanup();
      }
    },
  );

  it('sources every cell, starts Latin-first Arabic with U+200F and passes the claims registry', () => {
    for (const e of COMPARE_ENTRIES) {
      for (const cell of Object.values(e.rows)) expect(cell.source).toMatch(/^https:\/\//);
      for (const ar of [e.strong.ar, ...e.suits.ar, ...Object.values(e.rows).map((c) => c.text.ar)])
        expect(/^[A-Za-z]/.test(ar), ar).toBe(false);
      const en = [e.strong.en, ...e.suits.en].map((t, i) => [`${e.slug}.${i}`, t] as const);
      expect(findClaimViolations(en, 'en', new Date())).toEqual([]);
    }
  });

  it('dates every entry and reads every fact on the rival’s own site (SEO B3)', () => {
    const site = (url: string) => new URL(url).hostname.split('.').slice(-2).join('.');
    for (const e of COMPARE_ENTRIES) {
      expect(e.checkedOn, e.slug).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      for (const cell of Object.values(e.rows))
        expect(site(cell.source), e.slug).toBe(site(e.pricingUrl));
    }
    expect(new Set(COMPARE_ENTRIES.map((e) => e.slug)).size).toBe(COMPARE_ENTRIES.length);
  });
});
