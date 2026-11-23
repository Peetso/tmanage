import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { MyDayScreen } from '../src/components/screens/MyDayScreen';
import { expectNoAxeViolations } from './axe';

/**
 * HOME-05 follow-up (x144) — the Pinned section on the My Day screen.
 *
 * The screen is a faithful reader of the API's membership-scoped pins: this mounts it against a
 * client that answers each Home read, and asserts the Pinned section renders a pinned work item with
 * a link, and that the page has no axe violation jsdom can see (A11Y-01, matching the other
 * sections).
 */

const WORK_ITEM = '00000000-0000-4000-8000-0000000000d1';

/** A client that answers every Home read this screen makes, routing on the request URL. */
function homeClient(
  pins: unknown[],
  extra: readonly { match: string; body: unknown }[] = [],
): ApiClient {
  const bodies: { match: string; body: unknown }[] = [
    ...extra,
    { match: '/home/my-day', body: { items: [] } },
    { match: '/home/waiting', body: { items: [] } },
    {
      match: '/home/summary',
      body: {
        personalWork: { total: 0, overdue: 0, dueSoon: 0 },
        waiting: { total: 0, approvals: 0, clientRequests: 0, staleFollowUps: 0 },
      },
    },
    { match: '/home/saved-context', body: { groups: [] } },
    { match: '/home/pins', body: { pins } },
    { match: '/projects', body: { projects: [] } },
  ];
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((url: string) => {
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

describe('MyDayScreen — HOME-05 follow-up Pinned section', () => {
  it('renders a pinned work item with a link', async () => {
    const client = homeClient([
      {
        id: 'pin-1',
        targetKind: 'work',
        targetId: WORK_ITEM,
        createdAt: '2026-09-21T00:00:00.000Z',
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

    const list = await screen.findByRole('list', { name: 'Pinned to your Home' });
    const link = within(list).getByRole('link', { name: 'Pinned work item' });
    expect(link).toHaveAttribute('href', `/northstar-studio/work/${WORK_ITEM}`);

    await expectNoAxeViolations(container);
  });

  it("names a pinned item by its live title, read through the item's own GET", async () => {
    const client = homeClient(
      [
        {
          id: 'pin-1',
          targetKind: 'work',
          targetId: WORK_ITEM,
          createdAt: '2026-09-21T00:00:00.000Z',
        },
      ],
      [{ match: `/work-items/${WORK_ITEM}`, body: { id: WORK_ITEM, title: 'Atlas launch plan' } }],
    );
    render(
      withQuery(
        <MyDayScreen
          organizationSlug="northstar-studio"
          organizationName="Northstar Studio"
          client={client}
        />,
      ),
    );

    const list = await screen.findByRole('list', { name: 'Pinned to your Home' });
    const link = await within(list).findByRole('link', { name: 'Atlas launch plan' });
    expect(link).toHaveAttribute('href', `/northstar-studio/work/${WORK_ITEM}`);
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

    await waitFor(() => expect(screen.getByText('Nothing pinned yet')).toBeInTheDocument());
  });
});
