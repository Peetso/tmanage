import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { SearchScreen } from '../src/components/screens/SearchScreen';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * **SRCH-01 Global search (x111).**
 *
 * The tenant scoping, relation filter, order and bound are proved over fakes in
 * `apps/api/src/modules/search/search.service.test.ts`; nothing here re-proves them. What only
 * this file can prove is what the *screen* does with the answer: it renders the server's groups in
 * the server's order without re-sorting, links a work-item hit to its detail page, runs the search
 * the person typed, shows the empty state, and carries an accessible structure (a search landmark,
 * labelled groups) with no axe violation jsdom can detect.
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
  it('renders the server groups, links a work item, and is accessible', async () => {
    const { container } = render(screenOver(RESULTS, 'alpha'));

    const workGroup = await screen.findByRole('list', { name: /work items/i });
    expect(within(workGroup).getByRole('link', { name: 'Alpha task' })).toHaveAttribute(
      'href',
      '/acme/work/w1',
    );

    // Documents and meetings are named but not linked (no per-item route yet).
    const docGroup = screen.getByRole('list', { name: /documents/i });
    expect(within(docGroup).getByText('Alpha brief')).toBeInTheDocument();
    expect(within(docGroup).queryByRole('link')).toBeNull();
    expect(screen.getByRole('list', { name: /meetings/i })).toBeInTheDocument();

    await expectNoAxeViolations(container);
  });

  it('shows the empty state when nothing matches', async () => {
    render(screenOver([], 'zzz'));
    expect(await screen.findByText(/no matches/i)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: /work items/i })).toBeNull();
  });

  it('runs the search the person types and submits', async () => {
    const user = userEvent.setup();
    render(screenOver(RESULTS));

    // Nothing is fetched until a query is submitted.
    expect(screen.getByText(/search this organization/i)).toBeInTheDocument();

    await user.type(screen.getByRole('searchbox', { name: /what are you looking for/i }), 'alpha');
    await user.click(screen.getByRole('button', { name: /^search$/i }));

    await waitFor(() =>
      expect(screen.getByRole('list', { name: /work items/i })).toBeInTheDocument(),
    );
    expect(screen.getByRole('link', { name: 'Alpha task' })).toBeInTheDocument();
  });
});
