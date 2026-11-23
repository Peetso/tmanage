import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { MyDayScreen } from '../src/components/screens/MyDayScreen';
import { expectNoAxeViolations } from './axe';

/**
 * HOME-05's Saved section on the My Day screen.
 *
 * The screen is a faithful reader of the API's grouped pins: this mounts it against a client that
 * answers each Home read, and asserts the Saved section renders a pin grouped under its project
 * name, that a work pin links to the work item, and that the page has no axe violation jsdom can
 * see (A11Y-01, matching the other sections).
 */

const PROJECT = '00000000-0000-4000-8000-0000000000b1';
const WORK_ITEM = '00000000-0000-4000-8000-0000000000d1';

/** A client that answers every Home read this screen makes, routing on the request URL. */
function homeClient(savedGroups: unknown[]): ApiClient {
  const bodies: { match: string; body: unknown }[] = [
    { match: '/home/my-day', body: { items: [] } },
    { match: '/home/waiting', body: { items: [] } },
    {
      match: '/home/summary',
      body: {
        personalWork: { total: 0, overdue: 0, dueSoon: 0 },
        waiting: { total: 0, approvals: 0, clientRequests: 0, staleFollowUps: 0 },
      },
    },
    { match: '/home/saved-context', body: { groups: savedGroups } },
    { match: '/projects', body: { projects: [{ id: PROJECT, name: 'Atlas Website Relaunch' }] } },
  ];
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((url: string) => {
      // saved-context contains 'projects'? No — match longest/first specific match.
      const found = bodies.find((b) => url.includes(b.match));
      return Promise.resolve(
        new Response(JSON.stringify(found?.body ?? {}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'correlation-fixed',
  });
}

function withQuery(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('MyDayScreen — HOME-05 Saved section', () => {
  it('renders a pinned work item grouped under its project name, with a link', async () => {
    const client = homeClient([
      {
        projectId: PROJECT,
        items: [
          {
            id: 'pin-1',
            entityType: 'work',
            entityId: WORK_ITEM,
            createdAt: '2026-09-21T00:00:00.000Z',
          },
        ],
      },
    ]);

    const { container } = render(
      withQuery(
        <MyDayScreen
          organizationSlug="northstar-studio"
          organizationName="Northstar Studio"
          client={client}
        />,
      ),
    );

    const list = await screen.findByRole('list', { name: 'Saved in Atlas Website Relaunch' });
    const link = within(list).getByRole('link', { name: 'Saved work item' });
    expect(link).toHaveAttribute('href', `/northstar-studio/work/${WORK_ITEM}`);
    expect(screen.getByRole('heading', { name: 'Atlas Website Relaunch' })).toBeInTheDocument();

    await expectNoAxeViolations(container);
  });

  it('shows the empty state when nothing is pinned', async () => {
    const client = homeClient([]);
    render(
      withQuery(
        <MyDayScreen
          organizationSlug="northstar-studio"
          organizationName="Northstar Studio"
          client={client}
        />,
      ),
    );

    await waitFor(() => expect(screen.getByText('Nothing saved yet')).toBeInTheDocument());
  });
});
