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
});
