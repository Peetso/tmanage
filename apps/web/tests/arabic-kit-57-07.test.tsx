import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line no-restricted-imports -- a test reads the claim rules from source; nothing here ships to the browser.
import { findClaimViolations } from '../../../packages/domain/src/legal/public-claims';
import {
  ARABIC_FIRST_COPY,
  USE_CASE_COPY,
  USE_CASE_ENTRIES,
  useCaseMarkdown,
} from '../src/content/arabic/arabic-pages';
import { ARABIC_KIT_PATHS, ARABIC_USE_CASE_SLUGS } from '../src/content/arabic/arabic-slugs';
import { ARABIC_HELP_ARTICLES } from '../src/content/help/arabic-help';
import { findHelpArticle } from '../src/content/help/help-articles';
import {
  ArabicFirstPage,
  ArabicUseCasePage,
} from '../src/components/website/pages/arabic/ArabicFirstPage';
import { hasArabicTwin } from '../src/lib/i18n/public-locale-routes';
import { activeLocale } from '../src/lib/i18n/locale-store';
import { publicPageAt } from '../src/lib/public-pages';
import { publicPageMarkdown } from '../src/lib/site-text-files';
import sitemap from '../src/app/sitemap';

vi.mock('next/navigation', () => ({ usePathname: () => '/arabic', useRouter: () => ({}) }));
afterEach(() => (cleanup(), act(() => activeLocale.set('en-US'))));

const PRICE = /[$€£]|\bUSD\b|\bSAR\b|\bAED\b|\bEGP\b|ر\.س|جنيه|درهم/iu;

/** Every string of a nested copy object, with its path. */
function strings(value: unknown, path = ''): (readonly [string, string])[] {
  if (typeof value === 'string') return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((item, i) => strings(item, `${path}.${i}`));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value)
      .filter(([key]) => key !== 'kind')
      .flatMap(([key, item]) => strings(item, `${path}.${key}`));
  }
  return [];
}

const EN = [
  ...strings(ARABIC_FIRST_COPY.en, 'page'),
  ...USE_CASE_ENTRIES.flatMap((e) => strings(e.en, e.slug)),
  ...ARABIC_HELP_ARTICLES.flatMap((a) => strings(a.en, a.slug)),
];
const AR = [
  ...strings(ARABIC_FIRST_COPY.ar, 'page'),
  ...USE_CASE_ENTRIES.flatMap((e) => strings(e.ar, e.slug)),
  ...ARABIC_HELP_ARTICLES.flatMap((a) => strings(a.ar, a.slug)),
];

/** Row 57-07 (MENA) — the Arabic-first page, its use cases and the Arabic help starter set. */
describe('MENA kit content', () => {
  it('keeps the slug list equal to the entries, each help link real', () => {
    expect(USE_CASE_ENTRIES.map((e) => e.slug)).toEqual([...ARABIC_USE_CASE_SLUGS]);
    for (const e of USE_CASE_ENTRIES) expect(findHelpArticle(e.helpSlug), e.slug).toBeDefined();
  });

  it('passes the claims registry, names no price, and starts Latin-first Arabic with U+200F', () => {
    expect(findClaimViolations(EN, 'en', new Date())).toEqual([]);
    expect(findClaimViolations(AR, 'ar', new Date())).toEqual([]);
    for (const [key, text] of [...EN, ...AR]) expect(text, key).not.toMatch(PRICE);
    for (const [key, text] of AR) expect(/^[A-Za-z]/.test(text), key).toBe(false);
  });

  it('uses the review’s softened lines, never "every screen"', () => {
    expect(ARABIC_FIRST_COPY.en.features[0]?.body).toBe(
      'The interface runs right to left, and numbers, links and file names stay intact.',
    );
    for (const [key, text] of EN) expect(text, key).not.toMatch(/every screen/iu);
    for (const [key, text] of AR) expect(text, key).not.toMatch(/كل شاشة/u);
  });
});

describe('MENA kit routes', () => {
  it('gives every page an Arabic twin, a sitemap pair and a Markdown body', () => {
    const urls = sitemap().map((entry) => entry.url);
    for (const path of ARABIC_KIT_PATHS) {
      expect(hasArabicTwin(path), path).toBe(true);
      const page = publicPageAt(path);
      expect(page, path).toBeDefined();
      expect(urls.some((url) => url.endsWith(path))).toBe(true);
      expect(urls.some((url) => url.endsWith(`/ar${path}`))).toBe(true);
      expect(publicPageMarkdown(page!)).toContain('## ');
    }
    expect(useCaseMarkdown('nope')).toEqual([]);
  });
});

describe('MENA kit pages', () => {
  it.each(['en-US', 'ar-EG'] as const)('render the product page in %s', (loc) => {
    act(() => activeLocale.set(loc));
    const language = loc === 'ar-EG' ? 'ar' : 'en';
    const { container } = render(<ArabicFirstPage />);
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      ARABIC_FIRST_COPY[language].title,
    );
    const story = container.querySelector('#approval-story')?.parentElement;
    expect(story?.querySelectorAll('ol > li')).toHaveLength(3);
    expect(container.textContent).toContain(ARABIC_FIRST_COPY[language].betaNote);
  });

  it.each(['en-US', 'ar-EG'] as const)('render every use case in %s', (loc) => {
    act(() => activeLocale.set(loc));
    const language = loc === 'ar-EG' ? 'ar' : 'en';
    for (const entry of USE_CASE_ENTRIES) {
      const { container } = render(<ArabicUseCasePage entry={entry} />);
      expect(container.querySelectorAll('h1')).toHaveLength(1);
      expect(container.querySelectorAll('ol > li')).toHaveLength(entry[language].steps.length);
      expect(container.textContent).toContain(USE_CASE_COPY[language].more);
      expect(container.querySelector(`a[href$="/help/${entry.helpSlug}"]`)).not.toBeNull();
      cleanup();
    }
  });
});
