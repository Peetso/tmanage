import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { WorkBulkActionBar } from '../src/components/screens/WorkBulkActionBar';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * **Work bulk status transition (x206).**
 *
 * The tenant boundary and the per-id outcomes are proved over fakes with real authorize in
 * `apps/api/src/modules/work/bulk-transition.controller.test.ts`; nothing here re-proves them.
 * This file proves what only the bar can: it selects rows, sends one `POST …/bulk-transition`
 * with the chosen ids and target, reads back a mixed batch per item, and carries no axe
 * violation jsdom can detect.
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

const ITEMS = [
  { id: 'w-1', title: 'Draft the brief', state: 'in_progress' as const },
  { id: 'w-2', title: 'Review the draft', state: 'ready' as const },
];

function renderBar(client: ApiClient) {
  return render(
    withQuery(<WorkBulkActionBar organizationSlug="northstar" items={ITEMS} api={client} />),
  );
}

describe('WorkBulkActionBar', () => {
  it('renders the selectable rows and is accessible', async () => {
    const { client } = clientOver(() => json({ ok: true }));
    const { container } = renderBar(client);
    expect(screen.getByText('Draft the brief — In progress')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('sends one bulk-transition with the chosen ids and target, and reports the mixed result', async () => {
    const { client, calls } = clientOver((call) => {
      if (call.method === 'POST' && call.url.includes('/bulk-transition')) {
        return json({
          targetStatus: 'done',
          appliedCount: 1,
          results: [
            { id: 'w-1', outcome: 'applied', reason: null },
            { id: 'w-2', outcome: 'skipped_invalid', reason: 'A work item cannot move there' },
          ],
        });
      }
      return json({}, 404);
    });
    renderBar(client);
    const user = userEvent.setup();

    await user.click(screen.getByRole('checkbox', { name: /Draft the brief/ }));
    await user.click(screen.getByRole('checkbox', { name: /Review the draft/ }));
    await user.click(screen.getByRole('button', { name: /Change 2 to/ }));

    await waitFor(() => expect(screen.getByText(/1 of 2 moved to Done\./)).toBeInTheDocument());

    const bulk = calls.find((call) => call.url.includes('/bulk-transition'));
    expect(bulk?.method).toBe('POST');
    expect(bulk?.body).toEqual({ ids: ['w-1', 'w-2'], targetStatus: 'done' });
    // The one item that did not move is named with a plain reason.
    expect(screen.getByText('w-2: not a valid move')).toBeInTheDocument();
  });
});
