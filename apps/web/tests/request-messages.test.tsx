import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { RequestMessageThread } from '../src/components/requests/RequestMessageThread';
import { ApiClient } from '../src/lib/api/client';

/**
 * P8 — the conversation on a client request, team side and client side. Selectors are roles,
 * not words, so the suite holds before and after the `RequestMessages.*` keys merge.
 */

function clientOver(handler: (url: string, init?: RequestInit) => Response): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(handler(String(input), init))) as typeof globalThis.fetch,
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

const AT = '2026-08-13T10:05:00.000Z';

function renderThread(side: 'team' | 'client', api: ApiClient) {
  return render(
    withQuery(
      <RequestMessageThread
        side={side}
        organizationSlug="northstar"
        clientRequestId="req-1"
        client={api}
        studioName="Northstar Studio"
        clientName="Atlas Hospitality"
      />,
    ),
  );
}

describe('RequestMessageThread', () => {
  it('sends the internal-note flag as clientVisible=false from the team side', async () => {
    const sent: unknown[] = [];
    const api = clientOver((url, init) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { body: string; clientVisible: boolean };
        sent.push({ url, body });
        return json(
          {
            id: 'm-1',
            requestId: 'req-1',
            authorMembershipId: 'mem-1',
            authorKind: 'internal',
            body: body.body,
            clientVisible: body.clientVisible,
            createdAt: AT,
          },
          201,
        );
      }
      return json({ messages: [] });
    });
    const { container } = renderThread('team', api);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('switch'));
    await user.type(screen.getByRole('textbox'), 'Check the copy budget first{Enter}');

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({
      url: 'https://api.example.test/v1/organizations/northstar/client-requests/req-1/messages',
      body: { body: 'Check the copy budget first', clientVisible: false },
    });
    expect(await screen.findByText('Check the copy budget first')).toBeInTheDocument();
    expect(container.querySelector('.tm-chat-tag')).not.toBeNull();
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  it('shows a client post in the list, marked as theirs', async () => {
    const api = clientOver((url, init) => {
      expect(url).toContain('/portal/requests/req-1/messages');
      if (init?.method === 'POST') {
        return json(
          {
            id: 'm-2',
            requestId: 'req-1',
            from: 'client',
            mine: true,
            body: 'Reception is drafting it.',
            createdAt: AT,
          },
          201,
        );
      }
      return json({ messages: [] });
    });
    renderThread('client', api);
    const user = userEvent.setup();

    expect(screen.queryByRole('switch')).toBeNull();
    await user.type(await screen.findByRole('textbox'), 'Reception is drafting it.');
    await user.click(screen.getByRole('button'));

    const items = await screen.findAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent('Reception is drafting it.');
    expect(items[0]).toHaveAttribute('data-from', 'client');
  });

  it('reads the client projection, which carries no internal note', async () => {
    const urls: string[] = [];
    const api = clientOver((url) => {
      urls.push(url);
      return json({
        messages: [
          {
            id: 'm-3',
            requestId: 'req-1',
            from: 'studio',
            mine: false,
            body: 'Can you send the Arabic wording?',
            createdAt: AT,
          },
        ],
      });
    });
    const { container } = renderThread('client', api);

    expect(await screen.findByText('Can you send the Arabic wording?')).toBeInTheDocument();
    expect(urls.every((url) => url.includes('/portal/requests/'))).toBe(true);
    expect(container.querySelector('.tm-chat-tag')).toBeNull();
  });

  it('shows the not-found state, and no composer, for a 404 request', async () => {
    const api = clientOver(() =>
      json(
        { error: { code: 'not_found', message: 'Not found', correlationId: 'c', details: [] } },
        404,
      ),
    );
    const { container } = renderThread('team', api);

    await waitFor(() => expect(container.querySelector('[data-state="not-found"]')).not.toBeNull());
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
