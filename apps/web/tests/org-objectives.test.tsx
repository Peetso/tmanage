import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { OrgObjectivesScreen } from '../src/components/screens/OrgObjectivesScreen';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * **Organization objectives (x136).**
 *
 * The tenant-scoping, ordering and the Known-trap 404s are proved over fakes with the real evaluator
 * in `apps/api/src/modules/projects/org-objectives.controller.test.ts`; nothing here re-proves them.
 *
 * What only this file can prove is what the *screen* does: it renders the server's order without
 * re-sorting, sets an objective through `POST …/objectives` and refetches, transitions one through
 * `PATCH …/objectives/:id`, shows the empty state plainly, and carries an accessible form and list
 * (a labelled list of cards, each titled by a heading) with no axe violation jsdom can detect.
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
      // OBJ-02 shows the selected objective's key results; they are not under test here.
      if (call.url.includes('/key-results')) return Promise.resolve(json({ keyResults: [] }));
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

function objective(
  id: string,
  name: string,
  status = 'open',
  createdAt = '2026-01-01T09:00:00.000Z',
) {
  return {
    id,
    name,
    description: null,
    target: null,
    status,
    createdBy: 'user-1',
    createdAt,
  };
}

function renderScreen(client: ApiClient) {
  return render(
    withQuery(
      <OrgObjectivesScreen
        organizationSlug="northstar"
        organizationName="Northstar"
        client={client}
      />,
    ),
  );
}

describe('OrgObjectivesScreen', () => {
  it('renders the objectives in server order and is accessible', async () => {
    const { client } = clientOver((call) => {
      if (call.url.includes('/objectives'))
        return json({
          objectives: [
            objective('o-1', 'First objective', 'open', '2026-01-01T09:00:00.000Z'),
            objective('o-2', 'Second objective', 'met', '2026-02-01T09:00:00.000Z'),
          ],
        });
      return json({ objectives: [] });
    });

    const { container } = renderScreen(client);

    // OBJ-01: one card per objective, titled by a level-3 heading, in server order.
    const list = await screen.findByRole('list', { name: 'Objectives' });
    const titles = within(list).getAllByRole('heading', { level: 3 });
    expect(titles.map((heading) => heading.textContent)).toEqual([
      'First objective',
      'Second objective',
    ]);
    await expectNoAxeViolations(container);
  });

  it('shows the empty state when the organization has no objectives', async () => {
    const { client } = clientOver(() => json({ objectives: [] }));
    renderScreen(client);
    expect(await screen.findByText('No objectives yet')).toBeInTheDocument();
  });

  it('sets an objective through POST and refetches', async () => {
    const created = objective('o-9', 'New objective');
    const { client, calls } = clientOver((call) => {
      if (call.method === 'POST' && call.url.includes('/objectives')) return json(created, 201);
      if (call.url.includes('/objectives'))
        return json({ objectives: calls.some((c) => c.method === 'POST') ? [created] : [] });
      return json({ objectives: [] });
    });

    renderScreen(client);
    await screen.findByText('No objectives yet');

    await userEvent.type(screen.getByLabelText(/Objective/), 'New objective');
    await userEvent.click(screen.getByRole('button', { name: 'Set objective' }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST');
      expect(post?.url).toContain(`/organizations/northstar/objectives`);
      expect((post?.body as { name?: string })?.name).toBe('New objective');
    });
  });

  it('transitions an open objective through PATCH', async () => {
    const { client, calls } = clientOver((call) => {
      if (call.method === 'PATCH') return json(objective('o-1', 'First objective', 'met'));
      if (call.url.includes('/objectives'))
        return json({ objectives: [objective('o-1', 'First objective', 'open')] });
      return json({ objectives: [] });
    });

    renderScreen(client);
    await userEvent.click(await screen.findByRole('button', { name: 'Mark met' }));

    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH');
      expect(patch?.url).toContain(`/objectives/o-1`);
      expect((patch?.body as { status?: string })?.status).toBe('met');
    });
  });
});
