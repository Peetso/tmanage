import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { MarketingFaqScreen } from '../src/components/screens/MarketingFaqScreen';
import { ApiClient } from '../src/lib/api/client';
import type { PublicFaqView } from '../src/lib/api/public-faq';
import { expectNoAxeViolations } from './axe';

/**
 * **Public FAQ page (x186).** The grouped payload, public-door and no-drift shape are proved
 * API-side in `faq.controller.test.ts`; this proves only what the screen does — it renders the
 * server's content as a `<details>` accordion, carries landmarks and exactly one `<h1>`, and has no
 * axe violation jsdom can detect.
 */
const VIEW: PublicFaqView = {
  groups: [
    {
      id: 'getting-started',
      title: 'Getting started',
      items: [
        {
          id: 'what-is-tmanage',
          question: 'What is TManage?',
          answer: 'It keeps client work in one place.',
        },
      ],
    },
  ],
};

function clientReturning(view: PublicFaqView): ApiClient {
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

describe('MarketingFaqScreen', () => {
  it('renders the server content as an accessible accordion', async () => {
    const { container } = render(withQuery(<MarketingFaqScreen client={clientReturning(VIEW)} />));

    await waitFor(() => expect(screen.getByText('What is TManage?')).toBeDefined());
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByText('Getting started')).toBeDefined();
    expect(screen.getByText('It keeps client work in one place.')).toBeDefined();
    await expectNoAxeViolations(container);
  });
});
