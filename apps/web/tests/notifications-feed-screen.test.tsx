import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { NotificationsFeedScreen } from '../src/components/screens/NotificationsFeedScreen';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * Notifications feed web (x151). The API's own-principal scope, the `work.read` gate and the
 * mark-read resolve-before-write are proved in the controller unit test (and, in the chain, the
 * database suite); nothing here re-proves them. What only this file can prove is what the
 * *screen* does with the feed: it partitions unread from read, posts a single id to mark one
 * read, and mounts axe-clean.
 */

interface Call {
  readonly url: string;
  readonly method: string;
}

function clientOver(handler: (call: Call) => Response): { client: ApiClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = { url: String(input), method: init?.method ?? 'GET' };
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

const UNREAD_ID = '0199aa00-0000-7000-8000-000000000001';
const FEED = {
  items: [
    {
      id: UNREAD_ID,
      type: 'work_item.blocked.v1',
      objectType: 'work_item',
      objectId: 'work-1',
      read: false,
      createdAt: '2026-09-01T10:00:00.000Z',
      readAt: null,
    },
    {
      id: '0199aa00-0000-7000-8000-000000000002',
      type: 'client_request.submitted.v1',
      objectType: 'client_request',
      objectId: 'request-1',
      read: true,
      createdAt: '2026-08-30T10:00:00.000Z',
      readAt: '2026-08-31T10:00:00.000Z',
    },
  ],
  nextCursor: null,
};

describe('NotificationsFeedScreen', () => {
  it('partitions unread from read and marks one read by its id', async () => {
    const { client, calls } = clientOver((call) => {
      if (call.method === 'POST' && call.url.includes(`/notifications/${UNREAD_ID}/read`)) {
        return json({ ...FEED.items[0], read: true, readAt: '2026-09-02T00:00:00.000Z' });
      }
      if (call.url.includes('/notifications')) return json(FEED);
      return json({}, 200);
    });

    const { container } = render(
      withQuery(
        <NotificationsFeedScreen organizationSlug="acme" organizationName="Acme" client={client} />,
      ),
    );

    // The unread row carries the event in words and a mark-read control; the read row does not.
    expect(await screen.findByText('A work item you follow was blocked')).toBeTruthy();
    expect(await screen.findByText('A client submitted a request')).toBeTruthy();

    await expectNoAxeViolations(container);

    await userEvent.click(screen.getByRole('button', { name: /Mark read/ }));

    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.method === 'POST' && c.url.includes(`/notifications/${UNREAD_ID}/read`),
        ),
      ).toBe(true),
    );
  });

  it('names the deferred-request reminder in words, not as a wire type (A7)', async () => {
    const { client } = clientOver((call) => {
      if (call.url.includes('/notifications')) {
        return json({
          items: [
            {
              id: '0199aa00-0000-7000-8000-000000000003',
              type: 'client_request.reopened.v1',
              objectType: 'client_request',
              objectId: 'request-2',
              read: false,
              createdAt: '2026-09-03T08:00:00.000Z',
              readAt: null,
            },
          ],
          nextCursor: null,
        });
      }
      return json({}, 200);
    });

    render(
      withQuery(
        <NotificationsFeedScreen organizationSlug="acme" organizationName="Acme" client={client} />,
      ),
    );

    expect(await screen.findByText('A deferred request is back in triage')).toBeTruthy();
    expect(screen.queryByText('Client request reopened')).toBeNull();
  });

  it('shows an empty state when the feed is empty', async () => {
    const { client } = clientOver((call) => {
      if (call.url.includes('/notifications')) return json({ items: [], nextCursor: null });
      return json({}, 200);
    });

    const { container } = render(
      withQuery(
        <NotificationsFeedScreen organizationSlug="acme" organizationName="Acme" client={client} />,
      ),
    );

    expect(await screen.findByText('Nothing to catch up on')).toBeTruthy();
    await expectNoAxeViolations(container);
  });
});
