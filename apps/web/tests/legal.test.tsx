import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { MarketingLegalScreen } from '../src/components/screens/MarketingLegalScreen';
import { ApiClient } from '../src/lib/api/client';
import type { PublicLegalView } from '../src/lib/api/public-legal';
import { expectNoAxeViolations } from './axe';

/**
 * **Public legal page (x188).** The stable payload, effective date and no-drift shape are proved
 * API-side in `legal.controller.test.ts`; this proves only what the screen does — it renders the
 * server's document, carries landmarks, one `<h1>`, a labelled section-index nav whose links point
 * at the section anchors, and no axe violation jsdom can detect.
 */
const VIEW: PublicLegalView = {
  doc: 'terms',
  title: 'Terms of Service',
  effectiveDate: '2026-01-01',
  intro: 'These terms govern access to and use of the TManage service.',
  sections: [
    {
      id: 'accounts',
      heading: 'Accounts and organizations',
      body: 'The service is used through an organization.',
    },
    {
      id: 'acceptable-use',
      heading: 'Acceptable use',
      body: 'The service may not be used to break the law.',
    },
    {
      id: 'contact',
      heading: 'Contact',
      body: 'Email tm-support@peetrix.com or read https://developers.google.com/terms/api-services-user-data-policy.',
    },
  ],
};

function clientReturning(view: PublicLegalView): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: (() =>
      Promise.resolve(
        new Response(JSON.stringify(view), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'correlation-fixed',
  });
}

function withQuery(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('MarketingLegalScreen', () => {
  it('renders the server document with accessible structure and a working section index', async () => {
    const { container } = render(
      withQuery(<MarketingLegalScreen doc="terms" client={clientReturning(VIEW)} />),
    );

    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeDefined());
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Terms of Service');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);

    const index = screen.getByRole('navigation', { name: /terms of service sections/i });
    expect(index).toBeDefined();
    const link = screen.getByRole('link', { name: 'Acceptable use' });
    expect(link.getAttribute('href')).toBe('#acceptable-use');

    await expectNoAxeViolations(container);
  });

  it('turns the web and email addresses in the copy into links, leaving trailing punctuation', async () => {
    render(withQuery(<MarketingLegalScreen doc="terms" client={clientReturning(VIEW)} />));

    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeDefined());
    expect(screen.getByRole('link', { name: 'tm-support@peetrix.com' }).getAttribute('href')).toBe(
      'mailto:tm-support@peetrix.com',
    );
    const policy = 'https://developers.google.com/terms/api-services-user-data-policy';
    expect(screen.getByRole('link', { name: policy }).getAttribute('href')).toBe(policy);
  });
});

describe('legal short addresses', () => {
  it('permanently redirects /privacy and /terms to the legal pages', async () => {
    const { default: config } = await import('../next.config');
    const redirects = await config.redirects?.();
    expect(redirects).toEqual(
      expect.arrayContaining([
        { source: '/privacy', destination: '/legal/privacy', permanent: true },
        { source: '/terms', destination: '/legal/terms', permanent: true },
      ]),
    );
  });
});

describe('legal pages render their full text on the server', () => {
  it('puts the whole privacy policy, Google section included, in the server HTML', async () => {
    const { renderToString } = await import('react-dom/server');
    const { default: PrivacyPage } = await import('../src/app/(website)/legal/privacy/page');
    const html = renderToString(withQuery(<PrivacyPage />));

    expect(html).toContain('Privacy Policy');
    expect(html).toContain('Google user data');
    expect(html).toContain(
      'Google API Services User Data Policy, including the Limited Use requirements',
    );
    expect(html).toContain('https://developers.google.com/terms/api-services-user-data-policy');
    expect(html).not.toContain('Loading the document');
  });

  it('puts the terms in the server HTML too', async () => {
    const { renderToString } = await import('react-dom/server');
    const { default: TermsPage } = await import('../src/app/(website)/legal/terms/page');
    const html = renderToString(withQuery(<TermsPage />));

    expect(html).toContain('Terms of Service');
    expect(html).toContain('Google Drive and other integrations');
  });
});
