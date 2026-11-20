import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { LEGAL_DOCUMENTS, LEGAL_DOCUMENTS_AR, SIGNUP_ATTRIBUTION_COOKIE } from '@tmanage/domain';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { MarketingLegalScreen } from '../src/components/screens/MarketingLegalScreen';
import { DISPLAY_FORMAT_COOKIE_NAME } from '../src/lib/i18n/display-format-cookie';
import { LOCALE_COOKIE_NAME } from '../src/lib/i18n/locale-cookie';
import { DEFAULT_SESSION_COOKIE_NAME } from '../src/lib/public-config';
import { THEME_COOKIE_NAME } from '../src/lib/theme-cookie';

/**
 * **Cookie notice on /legal/privacy (2026-11-20).** The Cookies section names the cookies the web
 * really sets or relies on, taken from the code's own constants, so renaming a cookie without
 * updating the notice fails here. Both the English source and the Arabic translation are checked.
 */
const COOKIES = [
  DEFAULT_SESSION_COOKIE_NAME,
  `${DEFAULT_SESSION_COOKIE_NAME}_refresh`,
  `${DEFAULT_SESSION_COOKIE_NAME}_csrf`,
  LOCALE_COOKIE_NAME,
  THEME_COOKIE_NAME,
  DISPLAY_FORMAT_COOKIE_NAME,
  SIGNUP_ATTRIBUTION_COOKIE,
];

function cookiesBody(doc: { sections: readonly { id: string; body: string }[] }): string {
  const section = doc.sections.find((s) => s.id === 'cookies');
  expect(section, 'privacy policy has a cookies section').toBeDefined();
  return section?.body ?? '';
}

function withQuery(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('privacy policy cookie notice', () => {
  it.each([
    ['en', LEGAL_DOCUMENTS.privacy],
    ['ar', LEGAL_DOCUMENTS_AR.privacy],
  ])('names every cookie the web sets, by its real name (%s)', (_locale, doc) => {
    const body = cookiesBody(doc);
    for (const name of COOKIES) expect(body, name).toContain(name);
  });

  it('says there are no advertising or third-party tracking cookies and gives lifetimes', () => {
    const body = cookiesBody(LEGAL_DOCUMENTS.privacy);
    expect(body).toMatch(/do not use advertising cookies/);
    expect(body).toMatch(/third-party analytics or tracking cookies/);
    for (const lifetime of ['15 minutes', '14 days', '5 to 15 minutes', 'one year', '30 days']) {
      expect(body, lifetime).toContain(lifetime);
    }
  });

  it('renders the Cookies section on the page with its anchor in the section index', () => {
    render(withQuery(<MarketingLegalScreen doc="privacy" document={LEGAL_DOCUMENTS.privacy} />));
    const heading = screen.getByRole('heading', { level: 2, name: 'Cookies' });
    expect(heading.closest('section')?.id).toBe('cookies');
    expect(screen.getByRole('link', { name: 'Cookies' }).getAttribute('href')).toBe('#cookies');
    expect(heading.closest('section')?.textContent).toContain('tmanage_session_refresh');
  });
});
