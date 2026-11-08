import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HELP_ARTICLES,
  HELP_CATEGORIES,
  articlesIn,
  findHelpArticle,
} from '../src/content/help/help-articles';
import { normaliseForSearch, searchHelp } from '../src/content/help/help-search';
import { helpSlugForPath } from '../src/content/help/help-context';
import { HelpPage } from '../src/components/website/pages/help/HelpPage';
import { HelpArticlePage } from '../src/components/website/pages/help/HelpArticlePage';
import { HelpContextLink } from '../src/components/help/HelpContextLink';
import { activeLocale } from '../src/lib/i18n/locale-store';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/help',
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(() => {
  cleanup();
  act(() => activeLocale.set('en-US'));
});

/** Row 55-16 — Help centre EN/AR: content, search, context links and the two pages. */
describe('help centre content', () => {
  it('has at least 12 articles in English and Arabic, every topic covered, related links valid', () => {
    expect(HELP_ARTICLES.length).toBeGreaterThanOrEqual(12);
    for (const a of HELP_ARTICLES) {
      expect(a.en.title && a.ar.title && a.en.body.length && a.ar.body.length).toBeTruthy();
      expect(a.ar.title).toMatch(/[؀-ۿ]/);
      for (const r of a.related) expect(findHelpArticle(r), `${a.slug} → ${r}`).toBeDefined();
    }
    for (const c of HELP_CATEGORIES) expect(articlesIn(c.id).length).toBeGreaterThan(0);
  });
});

describe('help search', () => {
  it('normalises Arabic: diacritics, alef forms, taa marbuta and Arabic-Indic digits', () => {
    expect(normaliseForSearch('أَمَانٌ إدارة ٢')).toBe('امان اداره 2');
  });

  it('finds Arabic words with or without the article and hamza, and English words', () => {
    const slugs = (q: string) => searchHelp(q).map((a) => a.slug);
    expect(slugs('المهام')).toContain('create-and-assign-tasks');
    expect(slugs('اعتماد المشرف')[0]).toBe('task-approval');
    expect(slugs('امان')).toEqual(expect.arrayContaining(['two-step-sign-in']));
    expect(slugs('OneDrive')).toContain('connect-drive-onedrive');
    expect(slugs('   ')).toEqual([]);
    expect(slugs('zzzz')).toEqual([]);
  });
});

describe('help context links', () => {
  it('maps app screens to their article, longest pattern first', () => {
    expect(helpSlugForPath('/acme/work')).toBe('create-and-assign-tasks');
    expect(helpSlugForPath('/acme/work/42')).toBe('task-approval');
    expect(helpSlugForPath('/acme/finance/timesheets?week=3')).toBe('log-time-timesheets');
    expect(helpSlugForPath('/acme/admin/security')).toBe('two-step-sign-in');
    expect(helpSlugForPath('/acme/insights')).toBeUndefined();
    expect(helpSlugForPath('/platform/companies')).toBeUndefined();
  });

  it('renders a "?" to the article in the reader language, or nothing', () => {
    const { rerender, container } = render(<HelpContextLink pathname="/acme/clients" />);
    const link = screen.getByRole('link', { name: /Help for this page: Invite a client/ });
    expect(link.getAttribute('href')).toBe('/help/invite-a-client');
    act(() => activeLocale.set('ar-EG'));
    rerender(<HelpContextLink pathname="/acme/clients" />);
    expect(screen.getByRole('link').getAttribute('href')).toBe('/ar/help/invite-a-client');
    rerender(<HelpContextLink pathname="/acme/insights" />);
    expect(container.querySelector('a')).toBeNull();
  });
});

describe('help pages', () => {
  it('index lists the topics and swaps them for search results as you type', () => {
    render(<HelpPage />);
    expect(screen.getByRole('heading', { level: 3, name: 'Security' })).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'timesheet' } });
    expect(screen.getByRole('link', { name: 'Log time and submit timesheets' })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 3, name: 'Security' })).toBeNull();
  });

  it('article renders in Arabic with Arabic links', () => {
    act(() => activeLocale.set('ar-EG'));
    render(<HelpArticlePage article={findHelpArticle('task-approval')!} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'أرسل المهمة لاعتماد المشرف',
    );
    expect(screen.getByRole('link', { name: 'أنشئ المهام وأسندها' }).getAttribute('href')).toBe(
      '/ar/help/create-and-assign-tasks',
    );
  });
});
