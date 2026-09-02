import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { InboxScreen } from '../src/components/screens/InboxScreen';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * `TM-04 Inbox` — the Inbox part of `WEB-010`, over the first half of `INBOX-001`.
 *
 * What the API does — recipient-only rows, bundling, the silent drop of an object this person
 * may no longer read, the forward-only mark — is proved in
 * `apps/api/test/inbox-001-inbox.db.test.ts` against a real MySQL. Nothing here re-proves it.
 *
 * What only this file can prove is what the screen *does with* a page it was given:
 *
 * 1. **A bundle is one row that links to its object**, work item or client request, by the
 *    same paths `TM-10` and `REQ-01` use.
 * 2. **A mode is a query, not a filter over the page** — switching one asks the API again with
 *    `?mode=`, because the screen holds no rows the API did not choose for that mode.
 * 3. **Mark read posts the bundle id and then asks the list again**, rather than editing the
 *    row it holds: the API reauthorizes before it writes, and the screen has no way to know
 *    what it decided except by reading.
 * 4. **A further page is asked for by the cursor the API gave**, and only while it gives one.
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

function bundle(overrides: Record<string, unknown> = {}) {
  return {
    bundleId: 'work_item:wi-1',
    objectType: 'work_item',
    objectId: 'wi-1',
    title: 'Prepare mobile booking flow concepts',
    state: 'blocked',
    projectId: 'proj-1',
    count: 3,
    unreadCount: 2,
    types: ['work_item.blocked.v1'],
    latestAt: '2026-09-02T08:00:00.000Z',
    action: { kind: 'open' },
    ...overrides,
  };
}

const NAMES = { organizationSlug: 'northstar', organizationName: 'Northstar Studio' } as const;

function modeOf(url: string): string | null {
  return new URL(url).searchParams.get('mode');
}

// ─────────────────────────────────────────────────────────────────────────────

describe('TM-04 the inbox', () => {
  it('shows one row per bundle, linked to its object, and is accessible', async () => {
    const { client } = clientOver(() =>
      json({
        items: [
          bundle(),
          bundle({
            bundleId: 'client_request:req-9',
            objectType: 'client_request',
            objectId: 'req-9',
            title: 'Add Arabic booking FAQ before launch',
            state: 'submitted',
            count: 1,
            unreadCount: 0,
            types: ['client_request.submitted.v1'],
          }),
        ],
        nextCursor: null,
      }),
    );
    const { container } = render(withQuery(<InboxScreen {...NAMES} client={client} />));

    const work = await screen.findByRole('link', { name: 'Prepare mobile booking flow concepts' });
    expect(work).toHaveAttribute('href', '/northstar/work/wi-1');
    const request = screen.getByRole('link', { name: 'Add Arabic booking FAQ before launch' });
    expect(request).toHaveAttribute('href', '/northstar/work/requests/req-9');

    // The "why" is the event type in words, and the count is a count.
    const workRow = work.closest('tr') as HTMLTableRowElement;
    expect(within(workRow).getByText('Work item · Blocked')).toBeInTheDocument();
    expect(within(workRow).getByText(/3 updates/)).toBeInTheDocument();
    expect(within(workRow).getByText('2 unread')).toBeInTheDocument();
    expect(
      within(workRow).getByText('Blocked', { selector: '.tm-state-capsule' }),
    ).toBeInTheDocument();

    // Only an unread bundle offers "Mark read": a read one has nothing left to mark.
    expect(
      screen.getByRole('button', { name: 'Mark Prepare mobile booking flow concepts read' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Mark Add Arabic booking FAQ before launch read' }),
    ).not.toBeInTheDocument();

    // No "Load more" without a cursor.
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();

    await expectNoAxeViolations(container);
  });

  it('a mode is a query: switching one asks the API again with ?mode=', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientOver((call) => {
      if (modeOf(call.url) === 'important') return json({ items: [], nextCursor: null });
      return json({ items: [bundle()], nextCursor: null });
    });
    render(withQuery(<InboxScreen {...NAMES} client={client} />));

    await screen.findByRole('link', { name: 'Prepare mobile booking flow concepts' });
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    expect(modeOf(calls[0]?.url ?? '')).toBe('all');

    await user.click(screen.getByRole('button', { name: 'Important' }));

    expect(await screen.findByText('Nothing important is waiting')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Important' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false');
    expect(calls.map((call) => modeOf(call.url))).toEqual(['all', 'important']);
  });

  it('mark read posts the bundle id, then asks the list again', async () => {
    const user = userEvent.setup();
    let reads = 0;
    const { client, calls } = clientOver((call) => {
      if (call.method === 'POST') return json({ bundleId: 'work_item:wi-1', marked: 2 });
      reads += 1;
      // The second read is what the API says after the mark — no unread left.
      return json({
        items: [bundle({ unreadCount: reads === 1 ? 2 : 0 })],
        nextCursor: null,
      });
    });
    render(withQuery(<InboxScreen {...NAMES} client={client} />));

    await user.click(
      await screen.findByRole('button', { name: 'Mark Prepare mobile booking flow concepts read' }),
    );

    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Mark Prepare mobile booking flow concepts read' }),
      ).not.toBeInTheDocument();
    });

    const post = calls.find((call) => call.method === 'POST');
    // The bundle id is a path segment, so its colon is escaped rather than trusted.
    expect(post?.url).toBe(
      'https://api.example.test/v1/organizations/northstar/inbox/work_item%3Awi-1/read',
    );
    expect(reads).toBe(2);
    expect(screen.queryByText('2 unread')).not.toBeInTheDocument();
  });

  it('asks for the next page by the cursor the API gave, and only while it gives one', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientOver((call) => {
      const before = new URL(call.url).searchParams.get('before');
      if (before === null) {
        return json({ items: [bundle()], nextCursor: 'notif-oldest-on-page-1' });
      }
      return json({
        items: [bundle({ bundleId: 'work_item:wi-2', objectId: 'wi-2', title: 'Older work' })],
        nextCursor: null,
      });
    });
    render(withQuery(<InboxScreen {...NAMES} client={client} />));

    await user.click(await screen.findByRole('button', { name: 'Load more' }));

    expect(await screen.findByRole('link', { name: 'Older work' })).toBeInTheDocument();
    expect(new URL(calls[1]?.url ?? '').searchParams.get('before')).toBe('notif-oldest-on-page-1');
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    });
  });

  it('says what the API said when the inbox cannot be read', async () => {
    const { client } = clientOver(() =>
      json(
        {
          error: {
            code: 'validation_failed',
            message: 'The query is invalid',
            correlationId: 'corr-1',
            details: [{ field: 'mode', message: 'x is not an inbox mode' }],
          },
        },
        400,
      ),
    );
    render(withQuery(<InboxScreen {...NAMES} client={client} />));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load the inbox');
    expect(alert).toHaveTextContent('The query is invalid');
  });

  it('names what is not built, with the ticket that will build it', async () => {
    const { client } = clientOver(() => json({ items: [], nextCursor: null }));
    render(withQuery(<InboxScreen {...NAMES} client={client} />));

    expect(await screen.findByText('Nothing has happened yet')).toBeInTheDocument();
    expect(screen.getByText('Not built yet — INBOX-001')).toBeInTheDocument();
  });
});
