import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findClaimViolations } from '../../../packages/domain/src/legal/public-claims';
import { SwitchPage } from '../src/components/website/pages/compare/ComparePage';
import { SWITCH_COPY } from '../src/content/compare/compare-copy';
import { SWITCH_ENTRIES, importerFields } from '../src/content/compare/switch-entries';
import { activeLocale } from '../src/lib/i18n/locale-store';
import { publicPageAt } from '../src/lib/public-pages';
import { publicPageMarkdown } from '../src/lib/site-text-files';

vi.mock('next/navigation', () => ({ usePathname: () => '/switch/trello', useRouter: () => ({}) }));
afterEach(() => (cleanup(), act(() => activeLocale.set('en-US'))));

/** Row 54-29 — six switch pages, EN + AR, on the compare template; the table follows the importer. */
describe('switch pages', () => {
  it.each(['en-US', 'ar-EG'] as const)('render heading and Start free in %s', (loc) => {
    act(() => activeLocale.set(loc));
    const words = SWITCH_COPY[loc === 'ar-EG' ? 'ar' : 'en'];
    for (const entry of SWITCH_ENTRIES) {
      render(<SwitchPage entry={entry} />);
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(words.title(entry.name));
      expect(
        screen.getByRole('link', { name: /Start free|ابدأ مجانًا/u }).getAttribute('href'),
      ).toMatch(/sign-up$/u);
      cleanup();
    }
  });

  it('names only fields the importer reads, is listed with metadata, and passes the claims registry', () => {
    expect(SWITCH_ENTRIES.map((e) => e.slug)).toEqual([
      'monday',
      'asana',
      'clickup',
      'trello',
      'basecamp',
      'jira',
    ]);
    for (const e of SWITCH_ENTRIES) {
      const fields = importerFields(e);
      for (const row of e.rows)
        expect(fields.length === 0 ? 'archive' : fields, e.slug).toContain(row.field);
      const page = publicPageAt(`/switch/${e.slug}`);
      expect(page?.title).toBe(SWITCH_COPY.en.title(e.name));
      expect(publicPageMarkdown(page!)).toContain(e.how.en);
      const en = [e.how.en, ...e.situations.en].map((t, i) => [`${e.slug}.${i}`, t] as const);
      expect(findClaimViolations(en, 'en', new Date())).toEqual([]);
    }
  });
});
