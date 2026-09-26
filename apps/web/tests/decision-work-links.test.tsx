import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { DecisionWorkLinksPanel } from '../src/components/screens/DecisionWorkLinksPanel';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * **Decision → work links (x149).**
 *
 * The tenant-scoping and the Known-trap 404s are proved over fakes with real authorize in
 * `apps/api/src/modules/decisions/decision-work-links.controller.test.ts`; nothing here re-proves them.
 * This file proves what only the panel can: it renders the server's linked work, links a work item
 * through `POST …/work-links`, and carries an accessible form and list with no axe violation jsdom can
 * detect.
 */

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function clientOver(handler: (call: Call) => Response): { client: ApiClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        method: (init?.method ?? 'GET').toUpperCase(),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
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

const DECISION_ID = 'dec-1';

function link(linkId: string, workItemTitle: string) {
  return {
    linkId,
    decisionId: DECISION_ID,
    workItemId: `work-${linkId}`,
    workItemTitle,
    workItemState: 'in_progress',
    createdAt: '2026-01-01T09:00:00.000Z',
  };
}

function renderPanel(client: ApiClient) {
  return render(
    withQuery(
      <DecisionWorkLinksPanel
        organizationSlug="northstar"
        decisionId={DECISION_ID}
        decisionTitle="Adopt the new intake flow"
        client={client}
      />,
    ),
  );
}

describe('DecisionWorkLinksPanel', () => {
  it('renders the linked work and is accessible', async () => {
    const { client } = clientOver(() =>
      json({ workLinks: [link('l-1', 'Draft the brief'), link('l-2', 'Review the draft')] }),
    );
    const { container } = renderPanel(client);

    expect(await screen.findByText('Draft the brief')).toBeInTheDocument();
    expect(screen.getByText('Review the draft')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('shows the empty state when a decision has no linked work', async () => {
    const { client } = clientOver(() => json({ workLinks: [] }));
    renderPanel(client);
    expect(await screen.findByText('No linked work yet')).toBeInTheDocument();
  });

  it('links a work item through POST and refetches', async () => {
    const created = link('l-9', 'New work');
    const { client, calls } = clientOver((call) => {
      if (call.method === 'POST' && call.url.includes('/work-links')) return json(created, 201);
      if (call.url.includes('/work-links'))
        return json({ workLinks: calls.some((c) => c.method === 'POST') ? [created] : [] });
      return json({ workLinks: [] });
    });

    renderPanel(client);
    await screen.findByText('No linked work yet');

    await userEvent.type(screen.getByLabelText(/Work item ID/), 'work-l-9');
    await userEvent.click(screen.getByRole('button', { name: 'Link work item' }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST');
      expect(post?.url).toContain(`/decisions/${DECISION_ID}/work-links`);
      expect((post?.body as { workItemId?: string })?.workItemId).toBe('work-l-9');
    });
  });
});
