import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { DocumentCommentsPanel } from '../src/components/screens/DocumentCommentsPanel';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * **Docs "collaboration later" (x132) — document comments panel.**
 *
 * The API's authorize/relation logic and the Known-trap 404 are proved over fakes in `apps/api`;
 * nothing here re-proves them. What only this file can prove is what the *panel* does: it lists a
 * document's comments oldest-first, adds one through the form, shows the empty state when there are
 * none, and carries an accessible structure (a labelled region and list) with no axe violation.
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

const DOCUMENT_ID = 'doc-1';
const MEMBERSHIP = 'membership-1';

function comment(id: string, body: string) {
  return {
    id,
    documentId: DOCUMENT_ID,
    authorMembershipId: MEMBERSHIP,
    body,
    createdAt: '2026-09-20T10:00:00.000Z',
  };
}

function panelOver(comments: readonly ReturnType<typeof comment>[]) {
  const client = clientOver((call) => {
    if (call.url.includes(`/documents/${DOCUMENT_ID}/comments`)) {
      if (call.method === 'POST') return json(comment('doc-cmt-new', 'added'), 201);
      return json({ comments });
    }
    return json({}, 404);
  });
  return withQuery(
    <DocumentCommentsPanel organizationSlug="acme" documentId={DOCUMENT_ID} client={client} />,
  );
}

describe('DocumentCommentsPanel', () => {
  it('lists a document’s comments oldest-first and is accessible', async () => {
    const { container } = render(
      panelOver([comment('doc-cmt-1', 'first comment'), comment('doc-cmt-2', 'second comment')]),
    );

    const list = await screen.findByRole('list', { name: /comments on this document/i });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]!).toHaveTextContent('first comment');
    expect(items[1]!).toHaveTextContent('second comment');

    await expectNoAxeViolations(container);
  });

  it('shows the empty state when a document has no comments yet', async () => {
    render(panelOver([]));

    expect(await screen.findByText(/no comments yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: /comments on this document/i })).not.toBeInTheDocument();
  });

  it('adds a comment through the form', async () => {
    render(panelOver([]));
    const user = userEvent.setup();

    const textarea = await screen.findByLabelText(/add a comment/i);
    await user.type(textarea, 'a new comment');
    await user.click(screen.getByRole('button', { name: /add comment/i }));

    // The draft is cleared on a successful add.
    expect(await screen.findByLabelText(/add a comment/i)).toHaveValue('');
  });
});
