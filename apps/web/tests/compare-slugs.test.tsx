import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SwitchPage } from '../src/components/website/pages/compare/ComparePage';
import { HelpArticlePage } from '../src/components/website/pages/help/HelpArticlePage';
import { RESOURCE_SLUGS } from '../src/components/website/pages/resources/resource-slugs';
import { ALL_RESOURCES } from '../src/components/website/pages/resources/resources-data';
import { COMPARE_ENTRIES } from '../src/content/compare/compare-entries';
import { COMPARE_SLUGS, SWITCH_LINKS, SWITCH_SLUGS } from '../src/content/compare/compare-slugs';
import { SWITCH_ENTRIES } from '../src/content/compare/switch-entries';
import { HELP_ARTICLES, findHelpArticle } from '../src/content/help/help-articles';
import { HELP_SLUGS } from '../src/content/help/help-slugs';
import { activeLocale } from '../src/lib/i18n/locale-store';

vi.mock('next/navigation', () => ({ usePathname: () => '/switch/trello', useRouter: () => ({}) }));
afterEach(() => (cleanup(), act(() => activeLocale.set('en-US'))));

const hrefsOnPage = (): string[] =>
  screen.getAllByRole('link').map((link) => link.getAttribute('href') ?? '');

/**
 * SEOE (2026-11-17): the Arabic twin table is built from slug-only lists so the full content stays
 * out of the browser bundle. A page added to the content must be added to its slug list too, or
 * it would lose its Arabic twin, its `hreflang` and its sitemap entry.
 */
describe('slug-only lists', () => {
  it('name every page of their content, in the same order', () => {
    expect({
      compare: [...COMPARE_SLUGS],
      switch: [...SWITCH_SLUGS],
      switchNames: SWITCH_LINKS.map((links) => links.name),
      help: [...HELP_SLUGS],
      resources: [...RESOURCE_SLUGS],
    }).toEqual({
      compare: COMPARE_ENTRIES.map((entry) => entry.slug),
      switch: SWITCH_ENTRIES.map((entry) => entry.slug),
      switchNames: SWITCH_ENTRIES.map((entry) => entry.name),
      help: HELP_ARTICLES.map((article) => article.slug),
      resources: ALL_RESOURCES.map((item) => item.slug),
    });
  });
});

/** SEOE: a switch page, its "Move your work from X" help article and its compare page link up. */
describe('switch, help and compare pages of one product link to each other', () => {
  it.each(['en-US', 'ar-EG'] as const)('in %s', (locale) => {
    act(() => activeLocale.set(locale));
    const prefix = locale === 'ar-EG' ? '/ar' : '';
    for (const entry of SWITCH_ENTRIES) {
      const links = SWITCH_LINKS.find((item) => item.slug === entry.slug);
      const help = findHelpArticle(links?.helpSlug ?? '');
      expect(help, entry.slug).toBeDefined();
      render(<SwitchPage entry={entry} />);
      expect(hrefsOnPage()).toEqual(
        expect.arrayContaining([
          `${prefix}/help/${links?.helpSlug ?? ''}`,
          `${prefix}/compare/${links?.compareSlug ?? ''}`,
        ]),
      );
      cleanup();
      render(<HelpArticlePage article={help!} />);
      expect(hrefsOnPage()).toEqual(
        expect.arrayContaining([
          `${prefix}/switch/${entry.slug}`,
          `${prefix}/compare/${links?.compareSlug ?? ''}`,
        ]),
      );
      cleanup();
    }
  });
});
