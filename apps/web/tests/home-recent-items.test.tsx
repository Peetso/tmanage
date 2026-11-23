import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { HomeRecentItemsView } from '../src/components/screens/HomeRecentItemsView';
import { ApiClient } from '../src/lib/api/client';

/**
 * 2026-10-31 live test: every "Recently viewed" row read "Recently viewed work item". Each row now
 * shows the object's real title, read through the object's own authorized GET, and falls back to
 * the generic label only when that read is refused.
 */

function clientOver(handler: (url: string) => Response): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL) =>
      Promise.resolve(handler(String(input)))) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function withQuery(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('Home · Recently viewed', () => {
  it('shows each item’s real title and links it, falling back when the read is refused', async () => {
    const client = clientOver((url) => {
      if (url.endsWith('/home/recent-items')) {
        return json({
          items: [
            {
              id: 'r1',
              objectType: 'work',
              objectId: 'wi-1',
              viewedAt: '2026-10-31T20:00:00.000Z',
            },
            {
              id: 'r2',
              objectType: 'document',
              objectId: 'doc-1',
              viewedAt: '2026-10-31T19:00:00.000Z',
            },
            {
              id: 'r3',
              objectType: 'work',
              objectId: 'wi-gone',
              viewedAt: '2026-10-30T19:00:00.000Z',
            },
          ],
        });
      }
      if (url.endsWith('/work-items/wi-1'))
        return json({ id: 'wi-1', title: 'QA08 inbox test item' });
      if (url.endsWith('/documents/doc-1'))
        return json({ id: 'doc-1', title: 'Atlas launch plan' });
      return json({ code: 'not_found', message: 'Not found' }, 404);
    });

    render(withQuery(<HomeRecentItemsView organizationSlug="northstar" client={client} />));

    expect(await screen.findByRole('link', { name: 'QA08 inbox test item' })).toHaveAttribute(
      'href',
      '/northstar/work/wi-1',
    );
    expect(await screen.findByRole('link', { name: 'Atlas launch plan' })).toHaveAttribute(
      'href',
      '/northstar/docs/doc-1',
    );
    // The refused read keeps the generic label, still linked to where it was opened.
    expect(await screen.findByRole('link', { name: 'Recently viewed work item' })).toHaveAttribute(
      'href',
      '/northstar/work/wi-gone',
    );
    // The meta line names the kind in words, never the raw enum.
    expect(screen.queryByText(/^work ·/)).not.toBeInTheDocument();
  });
});
