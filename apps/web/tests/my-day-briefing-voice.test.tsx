import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { MyDayScreen } from '../src/components/screens/MyDayScreen';
import { BRIEFING_OWNER } from '../stories/support/briefing-fixtures';

/**
 * T4 F2 — one voice on My Day. The person's own list can be empty while the business briefing
 * right under it lists what needs them across the company; the empty lines then say what is empty
 * (nothing assigned to or waiting on you), never "Nothing needs you".
 */

function client(): ApiClient {
  const bodies: { match: string; body: unknown }[] = [
    { match: '/home/briefing', body: BRIEFING_OWNER },
    { match: '/home/widget-prefs', body: { order: [], hidden: [] } },
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
    { match: '/home/pins', body: { pins: [] } },
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

describe('My Day with an empty own list under a filled briefing (T4 F2)', () => {
  it('says the own list is empty, never that nothing needs the person', async () => {
    const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={query}>
        <MyDayScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          client={client()}
        />
      </QueryClientProvider>,
    );
    const briefing = await screen.findByRole('region', { name: 'Business briefing' });
    expect(within(briefing).getAllByRole('listitem').length).toBeGreaterThan(0);
    expect(
      await screen.findAllByText(/Nothing is assigned to you or waiting on you/u),
    ).not.toHaveLength(0);
    expect(screen.queryAllByText(/Nothing needs you/u)).toEqual([]);
  });
});
