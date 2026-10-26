import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { MeetingsScreen } from '../src/components/screens/MeetingsScreen';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * CAL-01 / MTG-01 web (x122). The API's tenant scoping, the `meeting.read`/`meeting.write` gates
 * and the 404-not-403 refusal are proved against a real MySQL in the x90/x105 database suites and
 * the controller unit tests; nothing here re-proves them. What only this file can prove is what the
 * *screen* does with those answers:
 *
 * - it lists a chosen project's meetings, sending `projectId` as a query parameter so the scoping
 *   is the server's, and links each row to its notes page;
 * - the create form posts a meeting to the chosen project (title, an ISO start instant, agenda);
 * - the mounted document is axe-clean (A11Y-01).
 */

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: string | undefined;
}

function clientOver(handler: (call: Call) => Response): { client: ApiClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : undefined,
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

const PROJECT = 'project-1';
const NOW = '2026-09-01T12:00:00.000Z';

const project = {
  id: PROJECT,
  workspaceId: 'ws-1',
  name: 'Rebrand',
  status: 'active',
  ownerUserId: null,
  committedAt: null,
  forecastAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
};

function meetingView(overrides: Record<string, unknown> = {}) {
  return {
    id: 'meeting-1',
    projectId: PROJECT,
    title: 'Kickoff',
    startsAt: '2026-10-01T14:00:00.000Z',
    agendaNote: null,
    createdByUserId: 'user-1',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function routeList(call: Call): Response {
  if (call.url.includes('/meetings?projectId=')) {
    return json({ meetings: [meetingView({ id: 'meeting-1', title: 'Kickoff' })] });
  }
  if (call.url.includes('/projects')) {
    return json({ projects: [project] });
  }
  if (call.url.includes('/workspaces')) {
    return json({ workspaces: [] });
  }
  return json({}, 200);
}

describe('MeetingsScreen', () => {
  it("lists a chosen project's meetings, scoped by projectId, and links each to its notes page", async () => {
    const { client, calls } = clientOver(routeList);
    const { container } = render(
      withQuery(
        <MeetingsScreen
          organizationSlug="acme"
          organizationName="Acme"
          initialProjectId={PROJECT}
          client={client}
        />,
      ),
    );

    const link = await screen.findByRole('link', { name: 'Kickoff' });
    expect(link).toHaveAttribute('href', '/acme/calendar/meetings/meeting-1');

    // The list read carried the project id to the API — the scoping is the server's.
    expect(calls.some((c) => c.url.includes(`/meetings?projectId=${PROJECT}`))).toBe(true);

    // The create form is present and axe-clean.
    expect(screen.getByRole('button', { name: 'Schedule meeting' })).toBeTruthy();

    await expectNoAxeViolations(container);
  });

  it("opens on All meetings and lists every project's meetings", async () => {
    const other = { ...project, id: 'project-2', name: 'Website' };
    const { client } = clientOver((call) => {
      if (call.url.includes('/meetings?projectId=project-2')) {
        return json({
          meetings: [
            meetingView({ id: 'meeting-9', projectId: 'project-2', title: 'Site review' }),
          ],
        });
      }
      if (call.url.includes('/projects')) return json({ projects: [project, other] });
      return routeList(call);
    });
    render(
      withQuery(<MeetingsScreen organizationSlug="acme" organizationName="Acme" client={client} />),
    );

    // Both projects' meetings are listed without choosing a project first.
    expect(await screen.findByRole('link', { name: 'Kickoff' })).toBeTruthy();
    expect(await screen.findByRole('link', { name: 'Site review' })).toBeTruthy();
    const select = screen.getByLabelText('Show the meetings for');
    expect((select as HTMLSelectElement).selectedOptions[0]?.textContent).toBe('All meetings');
  });

  it('posts a new meeting to the chosen project', async () => {
    const created: Call[] = [];
    const { client, calls } = clientOver((call) => {
      if (call.method === 'POST' && call.url.includes('/meetings')) {
        created.push(call);
        return json(meetingView({ id: 'meeting-2', title: 'Retro' }), 201);
      }
      return routeList(call);
    });

    render(
      withQuery(
        <MeetingsScreen
          organizationSlug="acme"
          organizationName="Acme"
          initialProjectId={PROJECT}
          client={client}
        />,
      ),
    );

    // Wait for the projects query so the create fieldset is enabled.
    await screen.findByRole('link', { name: 'Kickoff' });

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Retro' } });
    fireEvent.change(screen.getByLabelText('Starts'), {
      target: { value: '2026-10-02T09:30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Schedule meeting' }));

    await waitFor(() => expect(created.length).toBe(1));

    const body = JSON.parse(created[0]!.body as string) as Record<string, unknown>;
    expect(body['projectId']).toBe(PROJECT);
    expect(body['title']).toBe('Retro');
    // The wall-clock value was normalised to an ISO-8601 instant on the wire.
    expect(String(body['startsAt'])).toMatch(/^2026-10-02T\d{2}:\d{2}:00\.000Z$/);

    // The list was refetched after the create (invalidation).
    const listCalls = calls.filter((c) => c.url.includes('/meetings?projectId='));
    expect(listCalls.length).toBeGreaterThanOrEqual(2);
  });
});
