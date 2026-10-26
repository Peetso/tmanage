import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ContactScreen } from '../src/components/screens/ContactScreen';
import { LEGAL_DOCUMENTS_AR } from '../src/components/screens/legal-content-ar';
import { FOOTER_LEGAL, FOOTER_SOCIAL } from '../src/components/website/site-nav';
import { ApiClient } from '../src/lib/api/client';
import { localizeHref } from '../src/lib/i18n/public-locale-routes';
import { activeLocale } from '../src/lib/i18n/locale-store';
import { RouteLocaleProvider } from '../src/lib/i18n/route-locale';

/**
 * Hardening 2026-10-27. An Arabic page never sends a reader to the English legal pages: the
 * Arabic Terms cite the Arabic Privacy Policy, the contact page's Privacy link goes to its Arabic
 * twin, and each legal link lands on the matching document (terms → terms, privacy → privacy).
 * The footer carries no placeholder social profiles.
 */
afterEach(() => {
  act(() => activeLocale.set('en-US'));
});

const SITE = 'https://tmanage.peetrix.com';

describe('Arabic legal links', () => {
  it('the Arabic legal copy cites only the Arabic legal pages of the site', () => {
    for (const key of ['terms', 'privacy'] as const) {
      const text = Object.values(LEGAL_DOCUMENTS_AR[key].sections)
        .map((section) => section.body)
        .join(' ');
      const own = text.match(/https:\/\/tmanage\.peetrix\.com\/[^\s()]*/g) ?? [];
      for (const url of own) {
        expect(url.startsWith(`${SITE}/ar/`), url).toBe(true);
      }
    }
    const terms = Object.values(LEGAL_DOCUMENTS_AR.terms.sections)
      .map((section) => section.body)
      .join(' ');
    expect(terms).toContain(`${SITE}/ar/legal/privacy`);
    expect(terms).not.toContain(`${SITE}/legal/privacy`);
  });

  it('each footer legal link maps to the matching Arabic document', () => {
    for (const link of FOOTER_LEGAL) {
      expect(localizeHref(link.href)).toBe(`/ar${link.href}`);
    }
    expect(localizeHref('/legal/terms')).toBe('/ar/legal/terms');
    expect(localizeHref('/legal/privacy')).toBe('/ar/legal/privacy');
  });

  it('the contact page links its Arabic twin to the Arabic privacy page', () => {
    const client = new ApiClient({
      baseUrl: 'https://api.example.test',
      csrfCookieName: 'tm_session_csrf',
      fetch: (() => Promise.resolve(new Response('{}'))) as typeof globalThis.fetch,
      readCsrfToken: () => undefined,
      newCorrelationId: () => 'correlation-fixed',
    });
    const { container } = render(
      <RouteLocaleProvider locale="ar-EG">
        <ContactScreen client={client} />
      </RouteLocaleProvider>,
    );
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/ar/legal/privacy');
    expect(hrefs).not.toContain('/legal/privacy');
  });
});

describe('footer social links', () => {
  it('carries no placeholder profile (no bare LinkedIn or YouTube home page, no #)', () => {
    for (const item of FOOTER_SOCIAL) {
      expect(item.href).not.toBe('#');
      expect(item.href).not.toMatch(/^https:\/\/(www\.)?(linkedin|youtube)\.com\/?$/);
    }
  });
});
