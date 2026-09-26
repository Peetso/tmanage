import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ProjectObjectivesScreen } from '../src/components/screens/ProjectObjectivesScreen';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * **Project objectives (x124).**
 *
 * The tenant-scoping, ordering and the Known-trap 404s are proved over fakes and a real server in
 * `apps/api/src/modules/projects/project-objectives.controller.test.ts` and
 * `apps/api/test/proj-001-objectives.db.test.ts`; nothing here re-proves them.
 *
 * What only this file can prove is what the *screen* does: it renders the server's order without
 * re-sorting, sets an objective through `POST …/objectives` and refetches, transitions one through
 * `PATCH …/objectives/:id`, shows the empty state plainly, and carries an accessible form and list
 * (labelled regions, a caption, column headers) with no axe violation jsdom can detect.
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

const PROJECT_ID = 'proj-1';

function objective(
  id: string,
  name: string,
  status = 'open',
  createdAt = '2026-01-01T09:00:00.000Z',
) {
  return {
    id,
    projectId: PROJECT_ID,
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
      <ProjectObjectivesScreen
        organizationSlug="northstar"
        organizationName="Northstar"
        projectId={PROJECT_ID}
        client={client}
      />,
    ),
  );
}

describe('ProjectObjectivesScreen', () => {
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

    const table = await screen.findByRole('table');
    const rowHeaders = within(table).getAllByRole('rowheader');
    expect(rowHeaders.map((cell) => cell.textContent)).toEqual([
      'First objective',
      'Second objective',
    ]);
    await expectNoAxeViolations(container);
  });

  it('shows the empty state when a project has no objectives', async () => {
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
      expect(post?.url).toContain(`/projects/${PROJECT_ID}/objectives`);
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
