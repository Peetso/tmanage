import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WorkItemActivityFeed } from '../src/components/screens/WorkItemActivityFeed';
import { ApiClient } from '../src/lib/api/client';
import type { WorkActivityEntry } from '../src/lib/api/work-activity';

/**
 * 62-A2 (B09) — the work item timeline is now a thin use of the one `ActivityFeed`: it keeps the
 * item's sub-navigation, names the person, keeps a comment's links clickable, and says "System"
 * for a move nobody made.
 */
const ENTRIES: readonly WorkActivityEntry[] = [
  {
    id: 'c-1',
    kind: 'comment',
    action: 'work_item.commented',
    actorId: 'user-1',
    summary: 'See https://example.com/brief',
    occurredAt: new Date(Date.now() - 60_000).toISOString(),
    via: null,
    viaApp: null,
  },
  {
    id: 'a-1',
    kind: 'audit',
    action: 'work_item.transitioned',
    actorId: null,
    summary: 'Status changed to In review',
    occurredAt: new Date(Date.now() - 120_000).toISOString(),
    via: null,
    viaApp: null,
  },
];

function client(entries: readonly WorkActivityEntry[]): ApiClient {
  const fetch = ((input: RequestInfo | URL) => {
    const path = new URL(typeof input === 'string' ? input : input.toString()).pathname;
    const body = path.endsWith('/work-items/wi-7/activity')
      ? { activity: entries }
      : path.endsWith('/members')
        ? {
            members: [
              { userId: 'user-1', displayName: 'Omar Adel', role: 'manager', status: 'active' },
            ],
          }
        : {};
    return Promise.resolve(
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
    );
  }) as typeof globalThis.fetch;
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'correlation-test',
  });
}

function mount(entries: readonly WorkActivityEntry[]) {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={query}>
      <WorkItemActivityFeed
        organizationSlug="northstar"
        organizationName="Northstar Studio"
        workItemId="wi-7"
        client={client(entries)}
      />
    </QueryClientProvider>,
  );
}

describe('work item activity timeline', () => {
  it('draws the entries through the one feed, newest first', async () => {
    const { container } = mount(ENTRIES);
    expect(await screen.findByText(/Omar Adel —/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'https://example.com/brief' })).toHaveAttribute(
      'href',
      'https://example.com/brief',
    );
    expect(screen.getByText(/Status changed to In review/)).toBeInTheDocument();
    expect(container.querySelectorAll('.tm-act__item')).toHaveLength(2);
    expect(screen.getByRole('heading', { level: 3, name: 'Today' })).toBeInTheDocument();
  });

  it('keeps the item sub-navigation with Activity current', async () => {
    mount(ENTRIES);
    expect(await screen.findByRole('link', { name: 'Activity' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('says so when the item has no history yet', async () => {
    const { container } = mount([]);
    await screen.findByRole('region', { name: 'Activity' });
    await screen.findByText((_, node) => node?.classList.contains('tm-prose') ?? false);
    expect(container.querySelectorAll('.tm-act__item')).toHaveLength(0);
  });
});
