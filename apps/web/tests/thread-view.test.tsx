import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ThreadView } from '../src/components/screens/ThreadView';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * **x249 — a message's thread panel (planning ref CH-05).**
 *
 * The API's authorize/relation logic and the resolve-before-authorize 404 are proved over fakes in
 * `apps/api`; nothing here re-proves them. What only this file can prove is what the *panel* does:
 * it lists a message's replies oldest-first, replies through the form, shows the empty state when
 * there are none, and carries an accessible structure (a labelled region and list) with no axe
 * violation.
 */

interface Call {
  readonly url: string;
  readonly method: string;
}

function clientOver(handler: (call: Call) => Response): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(
        handler({ url: String(input), method: (init?.method ?? 'GET').toUpperCase() }),
      )) as typeof globalThis.fetch,
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

const CID = 'conv-1';
const MID = 'msg-1';
const MEMBERSHIP = 'membership-1';

function reply(id: string, body: string) {
  return {
    id,
    conversationId: CID,
    rootMessageId: MID,
    authorMembershipId: MEMBERSHIP,
    body,
    createdAt: '2026-09-20T10:00:00.000Z',
  };
}

function panelOver(replies: readonly ReturnType<typeof reply>[]) {
  const client = clientOver((call) => {
    if (call.url.includes(`/conversations/${CID}/messages/${MID}/thread`)) {
      if (call.method === 'POST') return json(reply('reply-new', 'added'), 201);
      return json({ rootMessageId: MID, replies, count: replies.length });
    }
    return json({}, 404);
  });
  return withQuery(
    <ThreadView organizationSlug="acme" conversationId={CID} rootMessageId={MID} client={client} />,
  );
}

describe('ThreadView (x249)', () => {
  it('lists a message’s replies oldest-first and is accessible', async () => {
    const { container } = render(
      panelOver([reply('reply-1', 'first reply'), reply('reply-2', 'second reply')]),
    );

    const list = await screen.findByRole('list', { name: /replies in this thread/i });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]!).toHaveTextContent('first reply');
    expect(items[1]!).toHaveTextContent('second reply');

    await expectNoAxeViolations(container);
  });

  it('shows the empty state when a message has no replies yet', async () => {
    render(panelOver([]));

    expect(await screen.findByText(/no replies yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: /replies in this thread/i })).not.toBeInTheDocument();
  });

  it('replies through the form', async () => {
    render(panelOver([]));
    const user = userEvent.setup();

    const textarea = await screen.findByLabelText(/reply in thread/i);
    await user.type(textarea, 'a new reply');
    await user.click(screen.getByRole('button', { name: /^reply$/i }));

    // The draft is cleared on a successful reply.
    expect(await screen.findByLabelText(/reply in thread/i)).toHaveValue('');
  });
});
