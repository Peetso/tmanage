import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { SearchScreen } from '../src/components/screens/SearchScreen';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * **SRCH-01 Global search (x111), ranked by SRCH ranking (x148).**
 *
 * The tenant scoping, relation filter, ranking and bound are proved over fakes in
 * `apps/api/src/modules/search/search.service.test.ts`; nothing here re-proves them. What only
 * this file can prove is what the *screen* does with the answer: it renders the server's hits as one
 * flat list in the server's ranked order without re-sorting or re-grouping, links a work-item hit to
 * its detail page, leaves other kinds as text, runs the search the person typed, shows the empty
 * state, and carries an accessible structure (a search landmark, a labelled results list) with no
 * axe violation jsdom can detect.
 */

interface Call {
  readonly url: string;
}

function clientOver(handler: (call: Call) => Response): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL) =>
      Promise.resolve(handler({ url: String(input) }))) as typeof globalThis.fetch,
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
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const RESULTS = [
  { kind: 'work_item', id: 'w1', title: 'Alpha task', projectId: 'p1', snippet: null },
  { kind: 'document', id: 'd1', title: 'Alpha brief', projectId: 'p1', snippet: null },
  { kind: 'meeting', id: 'm1', title: 'Alpha sync', projectId: 'p1', snippet: null },
];

function screenOver(results: unknown, initialQuery?: string) {
  const client = clientOver((call) => {
    if (call.url.includes('/search')) return json({ results });
    return json({}, 404);
  });
  return withQuery(
    <SearchScreen
      organizationSlug="acme"
      organizationName="Acme"
      client={client}
      {...(initialQuery === undefined ? {} : { initialQuery })}
    />,
  );
}

describe('SearchScreen', () => {
  it('renders one ranked list in the server order, links a work item, and is accessible', async () => {
    const { container } = render(screenOver(RESULTS, 'alpha'));

    const list = await screen.findByRole('list', { name: /search results/i });

    // The work item links to its detail page…
    expect(within(list).getByRole('link', { name: 'Alpha task' })).toHaveAttribute(
      'href',
      '/acme/work/w1',
    );
    // …while other kinds are named but not linked (no per-item route yet): only the one link.
    expect(within(list).getAllByRole('link')).toHaveLength(1);
    expect(within(list).getByText('Alpha brief')).toBeInTheDocument();
    expect(within(list).getByText('Alpha sync')).toBeInTheDocument();

    // Order is the server's ranking, not re-grouped by kind: w1, d1, m1 as returned.
    const items = within(list)
      .getAllByRole('listitem')
      .map((li) => li.textContent ?? '');
    expect(items[0]).toContain('Alpha task');
    expect(items[1]).toContain('Alpha brief');
    expect(items[2]).toContain('Alpha sync');

    await expectNoAxeViolations(container);
  });

  it('shows the empty state when nothing matches', async () => {
    render(screenOver([], 'zzz'));
    expect(await screen.findByText(/no matches/i)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: /search results/i })).toBeNull();
  });

  it('runs the search the person types and submits', async () => {
    const user = userEvent.setup();
    render(screenOver(RESULTS));

    // Nothing is fetched until a query is submitted.
    expect(screen.getByText(/search this organization/i)).toBeInTheDocument();

    await user.type(screen.getByRole('searchbox', { name: /what are you looking for/i }), 'alpha');
    await user.click(screen.getByRole('button', { name: /^search$/i }));

    await waitFor(() =>
      expect(screen.getByRole('list', { name: /search results/i })).toBeInTheDocument(),
    );
    expect(screen.getByRole('link', { name: 'Alpha task' })).toBeInTheDocument();
  });
});
