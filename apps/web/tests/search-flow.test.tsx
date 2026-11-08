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
 * flat list in the server's ranked order without re-sorting or re-grouping, links a work-item,
 * document or project hit to its detail page (CQ-13), leaves the kinds with no per-item route as
 * text, runs the search the person typed, shows the empty state, and carries an accessible structure
 * (a search landmark, a labelled results list) with no axe violation jsdom can detect.
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

const AT = '2026-10-13T16:20:00.000Z';
const RESULTS = [
  {
    kind: 'work_item',
    id: 'w1',
    title: 'Alpha task',
    projectId: 'p1',
    snippet: null,
    audience: 'client_visible',
    updatedAt: AT,
  },
  {
    kind: 'document',
    id: 'd1',
    title: 'Alpha brief',
    projectId: 'p1',
    snippet: null,
    audience: 'internal',
    updatedAt: AT,
  },
  {
    kind: 'meeting',
    id: 'm1',
    title: 'Alpha sync',
    projectId: 'p1',
    snippet: null,
    audience: 'internal',
    updatedAt: AT,
  },
];

function screenOver(results: unknown, initialQuery?: string, urls: string[] = []) {
  const client = clientOver((call) => {
    urls.push(call.url);
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

    // The work item links to its detail page, and a document links to its doc page (CQ-13)…
    expect(within(list).getByRole('link', { name: 'Alpha task' })).toHaveAttribute(
      'href',
      '/acme/work/w1',
    );
    expect(within(list).getByRole('link', { name: 'Alpha brief' })).toHaveAttribute(
      'href',
      '/acme/docs/d1',
    );
    // …while a meeting is named but not linked (no per-item route yet): two links in all.
    expect(within(list).getAllByRole('link')).toHaveLength(2);
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

  it('re-runs the search with the AUDIENCE and TIME facets as server filters', async () => {
    const user = userEvent.setup();
    const urls: string[] = [];
    const lastSearch = () => urls.filter((url) => url.includes('/search')).at(-1);
    render(screenOver(RESULTS, 'alpha', urls));
    await screen.findByRole('list', { name: /search results/i });
    expect(screen.getAllByTestId('search-hit-audience')[0]).toHaveTextContent('client visible');
    // SR-02 opens on the last 30 days with every audience ticked: only the time filter is sent.
    expect(screen.getByRole('button', { name: '30 days' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'All time' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(lastSearch()).toContain('since=30d');
    expect(lastSearch()).not.toMatch(/audience=/);

    // "All time" drops the time filter: neither filter is sent.
    await user.click(screen.getByRole('button', { name: 'All time' }));
    await waitFor(() => expect(lastSearch()).not.toMatch(/audience=|since=/));

    await user.click(screen.getByRole('checkbox', { name: /internal only/i }));
    await user.click(screen.getByRole('button', { name: '7 days' }));
    await waitFor(() =>
      expect(lastSearch()).toContain('audience=client_visible%2Cclient_action_required'),
    );
    expect(lastSearch()).toContain('since=7d');

    // No audience ticked: nothing is fetched and the screen says why.
    const before = urls.length;
    await user.click(screen.getByRole('checkbox', { name: /client visible/i }));
    await user.click(screen.getByRole('checkbox', { name: /client action required/i }));
    expect(await screen.findByText(/no audience selected/i)).toBeInTheDocument();
    expect(urls.filter((url) => url.includes('/search')).length).toBe(
      urls.slice(0, before).filter((url) => url.includes('/search')).length + 1,
    );
  });
  it('links invoice and file hits, and runs a TYPE capsule as a kinds= server filter (53-17)', async () => {
    const user = userEvent.setup();
    const urls: string[] = [];
    const finance = [
      {
        kind: 'invoice',
        id: 'i1',
        title: 'INV-0042',
        projectId: null,
        snippet: null,
        audience: 'client_visible',
        updatedAt: AT,
      },
      {
        kind: 'file',
        id: 'f1',
        title: 'فاتورة.pdf',
        projectId: 'p1',
        snippet: null,
        audience: 'internal',
        updatedAt: AT,
      },
    ];
    render(screenOver(finance, 'فاتوره', urls));
    const list = await screen.findByRole('list', { name: /search results/i });
    expect(within(list).getByRole('link', { name: 'INV-0042' })).toHaveAttribute(
      'href',
      '/acme/finance/invoices/i1',
    );
    expect(within(list).getByRole('link', { name: 'فاتورة.pdf' })).toHaveAttribute(
      'href',
      '/acme/files/f1',
    );

    // The TYPE capsules: All, the six workspace kinds, then Invoices (index 7).
    const typeGroup = screen.getByRole('group', { name: /type/i });
    await user.click(within(typeGroup).getAllByRole('button')[7] as HTMLElement);
    await waitFor(() =>
      expect(urls.filter((url) => url.includes('/search')).at(-1)).toContain('kinds=invoice'),
    );
  });
});
