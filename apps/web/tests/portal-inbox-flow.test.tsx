import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ClientInboxScreen } from '../src/components/screens/ClientInboxScreen';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * The client's inbox — INBOX-001's second half, on the portal.
 *
 * What the API does — a client reads only their own rows, a request outside the shared
 * projects is dropped, an internal principal is refused, the forward-only mark — is proved in
 * `apps/api/test/inbox-001-portal-inbox.db.test.ts` against a real MySQL. Nothing here
 * re-proves it.
 *
 * What only this file can prove is what the screen *does with* a page it was given:
 *
 * 1. **A bundle is one row that links to its request** on the portal's own path, and shows the
 *    client-safe status word `CL-06` uses.
 * 2. **A mode is a query, not a filter** — `Unread` asks the API again with `?mode=unread`.
 * 3. **Mark read posts the bundle id and then asks the list again.**
 * 4. **A further page is asked for by the cursor**, only while there is one, and pages are
 *    folded by bundle id; "nothing" is said only once the cursor is gone.
 */

interface Call {
  readonly url: string;
  readonly method: string | undefined;
}

function clientOver(handler: (call: Call) => Response): { client: ApiClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = { url: String(input), method: init?.method };
      calls.push(call);
      return Promise.resolve(handler(call));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
  return { client, calls };
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

const PROJECT = {
  id: 'proj-1',
  name: 'Atlas Website Relaunch',
  status: 'active',
  committedAt: null,
  forecastAt: null,
};

function bundle(overrides: Record<string, unknown> = {}) {
  return {
    bundleId: 'client_request:req-1',
    requestId: 'req-1',
    projectId: 'proj-1',
    title: 'Arabic booking FAQ on the rooms page',
    status: 'clarifying',
    count: 2,
    unreadCount: 1,
    types: ['client_request.transitioned.v1'],
    latestAt: '2026-09-02T08:00:00.000Z',
    action: { kind: 'open' },
    ...overrides,
  };
}

const NAMES = {
  organizationSlug: 'northstar',
  clientName: 'Atlas Hospitality',
  providerName: 'Northstar Studio',
} as const;

function isInbox(call: Call): boolean {
  return call.url.includes('/portal/inbox') && call.method !== 'POST';
}

function modeOf(url: string): string | null {
  return new URL(url).searchParams.get('mode');
}

function beforeOf(url: string): string | null {
  return new URL(url).searchParams.get('before');
}

function respond(call: Call, page: unknown): Response {
  if (call.url.includes('/portal/projects')) return json({ projects: [PROJECT] });
  return json(page);
}

// ─────────────────────────────────────────────────────────────────────────────

describe('the client inbox', () => {
  it('shows one row per request, linked on the portal path with the client-safe status, and is accessible', async () => {
    const { client } = clientOver((call) =>
      respond(call, {
        items: [
          bundle(),
          bundle({
            bundleId: 'client_request:req-2',
            requestId: 'req-2',
            title: 'Loyalty desk',
            status: 'declined',
            count: 1,
            unreadCount: 0,
          }),
        ],
        nextCursor: null,
      }),
    );

    const { container } = render(withQuery(<ClientInboxScreen {...NAMES} client={client} />));

    const list = await screen.findByRole('list', { name: 'Your notifications' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);

    const first = within(rows[0] as HTMLElement);
    expect(
      first.getByRole('link', { name: 'Arabic booking FAQ on the rooms page' }),
    ).toHaveAttribute('href', '/northstar/portal/requests/req-1');
    // The status is the client's word, not the internal state.
    expect(first.getByText('Waiting for your answer')).toBeInTheDocument();
    expect(first.getByText('2 updates, 1 unread')).toBeInTheDocument();
    // The latest time is an instant, not a calendar date: the hour survives.
    expect(first.getByText(/Latest .*\d{1,2}:\d{2}/)).toBeInTheDocument();
    expect(
      first.getByRole('button', { name: 'Mark read: Arabic booking FAQ on the rooms page' }),
    ).toBeInTheDocument();

    const second = within(rows[1] as HTMLElement);
    expect(second.getByText('Declined')).toBeInTheDocument();
    expect(second.queryByRole('button', { name: /mark read/i })).not.toBeInTheDocument();

    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('asks the API again with the mode rather than filtering the page it holds', async () => {
    const { client, calls } = clientOver((call) =>
      respond(
        call,
        modeOf(call.url) === 'unread'
          ? { items: [bundle()], nextCursor: null }
          : {
              items: [
                bundle(),
                bundle({
                  bundleId: 'client_request:req-2',
                  requestId: 'req-2',
                  title: 'Read already',
                  unreadCount: 0,
                }),
              ],
              nextCursor: null,
            },
      ),
    );
    const user = userEvent.setup();

    render(withQuery(<ClientInboxScreen {...NAMES} client={client} />));
    await screen.findByRole('link', { name: 'Read already' });

    const unread = screen.getByRole('button', { name: 'Unread' });
    expect(unread).toHaveAttribute('aria-pressed', 'false');
    await user.click(unread);

    await waitFor(() =>
      expect(screen.queryByRole('link', { name: 'Read already' })).not.toBeInTheDocument(),
    );
    expect(unread).toHaveAttribute('aria-pressed', 'true');
    // In `unread` every row the API returned is unread, so the copy claims no total.
    expect(screen.getByText('1 unread')).toBeInTheDocument();
    expect(screen.queryByText(/of \d/)).not.toBeInTheDocument();
    expect(calls.filter(isInbox).map((call) => modeOf(call.url))).toEqual(['all', 'unread']);
  });

  it('mark read posts the bundle id and then reads the list again', async () => {
    let marked = false;
    const { client, calls } = clientOver((call) => {
      if (call.method === 'POST') {
        marked = true;
        return json({ bundleId: 'client_request:req-1', marked: 1 });
      }
      return respond(call, {
        items: [bundle({ unreadCount: marked ? 0 : 1 })],
        nextCursor: null,
      });
    });
    const user = userEvent.setup();

    render(withQuery(<ClientInboxScreen {...NAMES} client={client} />));
    await user.click(
      await screen.findByRole('button', {
        name: 'Mark read: Arabic booking FAQ on the rooms page',
      }),
    );

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /^Mark read/ })).not.toBeInTheDocument(),
    );
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.url).toContain('/portal/inbox/client_request%3Areq-1/read');
    expect(calls.filter(isInbox)).toHaveLength(2);
    expect(screen.getByText('2 updates')).toBeInTheDocument();
  });

  it('asks for the next page by the cursor, folds a bundle that straddles pages, and says nothing only once the cursor is gone', async () => {
    const { client, calls } = clientOver((call) => {
      if (beforeOf(call.url) === 'cursor-1') {
        return respond(call, {
          items: [
            bundle({
              count: 1,
              unreadCount: 0,
              // An older page, with a type the newer page did not carry: the fold must union
              // the types and keep the newer time.
              types: ['client_request.transitioned.v1', 'client_request.mystery.v9'],
              latestAt: '2026-09-01T08:00:00.000Z',
            }),
          ],
          nextCursor: null,
        });
      }
      return respond(call, { items: [bundle()], nextCursor: 'cursor-1' });
    });
    const user = userEvent.setup();

    render(withQuery(<ClientInboxScreen {...NAMES} client={client} />));
    await screen.findByRole('link', { name: 'Arabic booking FAQ on the rooms page' });
    expect(screen.getByText('2 updates, 1 unread')).toBeInTheDocument();
    const before = screen.getByText(/Latest /).textContent;

    await user.click(screen.getByRole('button', { name: 'Load more' }));

    // Folded: one row, counts added, the newest time kept, the types united — and an
    // unknown type says nothing, because the screen never prints an identifier.
    await waitFor(() => expect(screen.getByText('3 updates, 1 unread')).toBeInTheDocument());
    expect(screen.getByText(/Latest /).textContent).toBe(before);
    expect(screen.getByText(/Northstar Studio answered/)).toBeInTheDocument();
    expect(screen.queryByText(/mystery/)).not.toBeInTheDocument();
    expect(
      screen.getAllByRole('link', { name: 'Arabic booking FAQ on the rooms page' }),
    ).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    expect(calls.filter(isInbox).map((call) => beforeOf(call.url))).toEqual([null, 'cursor-1']);
  });

  it('a short page with a cursor is not "nothing"; an empty page without one is', async () => {
    const { client } = clientOver((call) => {
      if (beforeOf(call.url) === 'cursor-1') return respond(call, { items: [], nextCursor: null });
      return respond(call, { items: [], nextCursor: 'cursor-1' });
    });
    const user = userEvent.setup();

    render(withQuery(<ClientInboxScreen {...NAMES} client={client} />));
    expect(await screen.findByText(/Nothing you can still see on this page/)).toBeInTheDocument();
    expect(screen.queryByText('Nothing has changed yet')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Nothing has changed yet')).toBeInTheDocument();
  });

  // The two error branches. Neither was rendered by any case above until the review fleet
  // said so on 2026-09-03; a screen that dropped either alert would have stayed green.

  it('says when the list could not be loaded, and does not call it empty', async () => {
    const { client } = clientOver((call) =>
      call.url.includes('/portal/projects')
        ? json({ projects: [PROJECT] })
        : json({ error: { code: 'internal_error', message: 'The portal fell over' } }, 500),
    );

    render(withQuery(<ClientInboxScreen {...NAMES} client={client} />));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load your notifications');
    expect(screen.queryByText('Nothing has changed yet')).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Your notifications' })).not.toBeInTheDocument();
  });

  it('says when a mark could not be made, and forgets it on a mode change', async () => {
    const { client } = clientOver((call) => {
      if (call.method === 'POST') {
        return json({ error: { code: 'not_found', message: 'Not found' } }, 404);
      }
      return respond(call, { items: [bundle()], nextCursor: null });
    });
    const user = userEvent.setup();

    render(withQuery(<ClientInboxScreen {...NAMES} client={client} />));
    await user.click(
      await screen.findByRole('button', {
        name: 'Mark read: Arabic booking FAQ on the rooms page',
      }),
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not mark that read');
    // The row is still there, still unread: nothing was pretended.
    expect(screen.getByText('2 updates, 1 unread')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Unread' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});
