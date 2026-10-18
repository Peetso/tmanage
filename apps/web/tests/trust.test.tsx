import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { TrustScreen } from '../src/components/screens/TrustScreen';
import { ApiClient } from '../src/lib/api/client';
import type { PublicTrustView } from '../src/lib/api/public-trust';
import { expectNoAxeViolations } from './axe';

/**
 * **Public security & trust page (x158).** The controls, subprocessors and no-drift shape are
 * proved API-side in `trust-content.controller.test.ts`; this proves only what the screen does —
 * it renders the server's content and carries landmarks, one `<h1>`, a captioned table and no
 * axe violation jsdom can detect.
 */
const VIEW: PublicTrustView = {
  controls: [
    {
      id: 'access',
      title: 'Access control',
      summary: 'Every request is authenticated.',
      controls: ['Sessions are short-lived.'],
    },
  ],
  dataHandling: ['Customer data belongs to the customer.'],
  subprocessors: [{ name: 'Hostinger', purpose: 'Hosting', location: 'European Union' }],
  compliance: ['Independent certification is on the roadmap.'],
  statusPath: '/status',
};

function clientReturning(view: PublicTrustView): ApiClient {
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

describe('TrustScreen', () => {
  it('renders the server content with accessible structure', async () => {
    const { container } = render(withQuery(<TrustScreen client={clientReturning(VIEW)} />));

    await waitFor(() => expect(screen.getByText('Hostinger')).toBeDefined());
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('table', { name: /subprocessors/i })).toBeDefined();
    expect(screen.getByRole('link', { name: 'Open status page' }).getAttribute('href')).toBe(
      '/status',
    );
    await expectNoAxeViolations(container);
  });
});
