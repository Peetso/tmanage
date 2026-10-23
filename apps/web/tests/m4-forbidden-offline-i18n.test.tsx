import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import ForbiddenPage from '../src/app/forbidden/page';
import OfflinePage from '../src/app/offline/page';
import { localizedWebsiteTitle } from '../src/components/website/WebsiteDocumentTitle';
import { STATE_COPY } from '../src/components/state/state-copy';
import { activeLocale } from '../src/lib/i18n/locale-store';
import { translate, type MessageKey } from '../src/lib/i18n/t';

/**
 * **M4 — /forbidden and /offline in Arabic (live recheck 9c6d816c).** Both states follow the
 * active locale, carry the language switch in their bar, and their tab titles are rewritten.
 * New keys arrive through `i18n-M4.*.json`, so every expectation holds before the merge
 * (English fallback) and after it (the Arabic string).
 */
const arOr = (key: string, english: string) => {
  const value = translate('ar-EG', key as MessageKey);
  return value === key ? english : value;
};

afterEach(() => {
  act(() => activeLocale.set('en-US'));
  document.title = '';
});

describe('/forbidden', () => {
  it('keeps the English copy in English', () => {
    render(<ForbiddenPage />);
    expect(screen.getByRole('heading', { name: STATE_COPY.forbidden.title })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: STATE_COPY.forbidden.action! })).toBeInTheDocument();
  });

  it('switches to Arabic from its own language switch', async () => {
    render(<ForbiddenPage />);
    await userEvent.click(screen.getByRole('button', { name: 'العربية' }));
    expect(
      screen.getByRole('heading', {
        name: arOr('StateScreens.forbiddenTitle', STATE_COPY.forbidden.title),
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: translate('ar-EG', 'StateScreens.backToHome') }),
    ).toBeInTheDocument();
    expect(screen.getByText(translate('ar-EG', 'WebsiteChrome.skipLink'))).toBeInTheDocument();
    expect(
      screen.getByText(translate('ar-EG', 'StateScreens.eyebrowForbidden'), {
        selector: '.tm-state-screen__label',
      }),
    ).toBeInTheDocument();
  });
});

describe('/offline', () => {
  it('renders the same English copy as before', () => {
    render(<OfflinePage />);
    expect(screen.getByRole('heading', { name: 'You’re offline' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Try again' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('group')).toBeInTheDocument();
  });

  it('follows the Arabic locale', () => {
    act(() => activeLocale.set('ar-EG'));
    render(<OfflinePage />);
    expect(
      screen.getByRole('heading', { name: arOr('StateScreens.offlineTitle', 'You’re offline') }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: arOr('StateScreens.offlineTryAgain', 'Try again') }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'العربية' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('state tab titles', () => {
  it('rewrites the forbidden and offline titles in Arabic', () => {
    expect(
      localizedWebsiteTitle('Access denied · TManage', 'ar-EG') ?? 'Access denied · TManage',
    ).toBe(`${arOr('WebsiteTitle.forbidden', 'Access denied')} · TManage`);
    expect(localizedWebsiteTitle('Offline · TManage', 'ar-EG') ?? 'Offline · TManage').toBe(
      `${arOr('WebsiteTitle.offline', 'Offline')} · TManage`,
    );
  });

  it('writes the Arabic title on the offline page', () => {
    document.title = 'Page not found · TManage';
    act(() => activeLocale.set('ar-EG'));
    render(<OfflinePage />);
    expect(document.title).toBe(`${translate('ar-EG', 'WebsiteTitle.notFound')} · TManage`);
  });
});
