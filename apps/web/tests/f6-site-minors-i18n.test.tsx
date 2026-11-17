import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WebsiteDocumentTitle,
  WEBSITE_TITLE_KEYS,
  localizedWebsiteTitle,
} from '../src/components/website/WebsiteDocumentTitle';
import { WebsiteChrome } from '../src/components/website/WebsiteChrome';
import { NotFoundState } from '../src/components/state/StateScreens';
import { STATE_COPY } from '../src/components/state/state-copy';
import { activeLocale } from '../src/lib/i18n/locale-store';
import { translate, type MessageKey } from '../src/lib/i18n/t';

vi.mock('next/navigation', () => ({ usePathname: () => '/pricing' }));

/**
 * **F6 — site minors from the 2026-10-23 recheck.** The tab title, the live-region names and the
 * 404 copy follow the active locale. New keys arrive through `F6-i18n-fragment.json`, so every
 * expectation holds before the merge (English fallback) and after it (the Arabic string).
 */
const arOr = (key: string, english: string) => {
  const value = translate('ar-EG', key as MessageKey);
  return value === key ? english : value;
};

afterEach(() => {
  act(() => activeLocale.set('en-US'));
  document.title = '';
});

describe('localizedWebsiteTitle', () => {
  it('translates the home title through the hero line', () => {
    const english = `TManage — ${translate('en-US', 'HomePage.betaHeroTitle')}`;
    expect(localizedWebsiteTitle(english, 'ar-EG')).toBe(
      `TManage — ${translate('ar-EG', 'HomePage.betaHeroTitle')}`,
    );
    expect(localizedWebsiteTitle(english, 'en-US')).toBe(english);
  });

  it('maps every known page name and leaves unknown titles alone', () => {
    for (const [name, key] of Object.entries(WEBSITE_TITLE_KEYS)) {
      const out = localizedWebsiteTitle(`${name} · TManage`, 'ar-EG');
      expect(out ?? `${name} · TManage`).toBe(`${arOr(key, name)} · TManage`);
    }
    expect(localizedWebsiteTitle('Some guide · TManage', 'ar-EG')).toBeUndefined();
    expect(localizedWebsiteTitle('TManage', 'ar-EG')).toBeUndefined();
  });
});

describe('WebsiteDocumentTitle', () => {
  it('follows the locale and restores English when switched back', () => {
    const english = `TManage — ${translate('en-US', 'HomePage.betaHeroTitle')}`;
    document.title = english;
    act(() => activeLocale.set('ar-EG'));
    render(<WebsiteDocumentTitle />);
    expect(document.title).toBe(`TManage — ${translate('ar-EG', 'HomePage.betaHeroTitle')}`);
    act(() => activeLocale.set('en-US'));
    expect(document.title).toBe(english);
  });
});

describe('Arabic labels', () => {
  it('names the website live region in the active language', () => {
    act(() => activeLocale.set('ar-EG'));
    render(<WebsiteChrome>content</WebsiteChrome>);
    expect(
      screen.getByRole('region', { name: arOr('Shell.liveAnnouncements', 'Live announcements') }),
    ).toBeInTheDocument();
  });

  it('renders the 404 copy through the catalog, English unchanged', () => {
    render(<NotFoundState autoFocusAction={false} />);
    expect(screen.getByRole('heading', { name: STATE_COPY.notFound.title })).toBeInTheDocument();
    expect(screen.getByText(STATE_COPY.notFound.description)).toBeInTheDocument();
  });

  it('renders the Arabic 404 action', () => {
    act(() => activeLocale.set('ar-EG'));
    render(<NotFoundState autoFocusAction={false} />);
    expect(
      screen.getByRole('link', { name: translate('ar-EG', 'StateScreens.backToHome') }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        name: arOr('StateScreens.notFoundTitle', STATE_COPY.notFound.title),
      }),
    ).toBeInTheDocument();
  });
});
