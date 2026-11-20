import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ClientActionsScreen } from '../src/components/screens/ClientActionsScreen';
import { ClientOverviewScreen } from '../src/components/screens/ClientOverviewScreen';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * `CL-01` and `CL-02` against the endpoints CLIENT-002 delivered.
 *
 * What the API does — the projection, the audience predicate, one client not seeing another —
 * is proved in `apps/api/test/client-002-portal.db.test.ts` against a real MySQL. Nothing here
 * re-proves any of it.
 *
 * What only this file can prove is what the portal *says*:
 *
 * - **No internal task percentage**, which `22-SCREEN-BY-SCREEN` §6 puts in bold and which is
 *   the one rule on `CL-01` that a well-meaning screen breaks first.
 * - Required actions come first, and the empty state says both halves of §6's "empty state
 *   confirms notification behavior".
 * - Agreed and estimated dates are named as different things, in words a client reads.
 */

function clientOver(handler: (url: string) => Response): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL) =>
      Promise.resolve(handler(String(input)))) as typeof globalThis.fetch,
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

const NOW = new Date('2026-09-01T12:00:00.000Z');

const PROJECT = {
  id: 'proj-1',
  name: 'Atlas Website Relaunch',
  status: 'active',
  committedAt: '2026-10-15',
  forecastAt: '2026-10-29',
};

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wi-1',
    projectId: 'proj-1',
    title: 'The homepage design',
    progress: 'in_progress',
    dueAt: '2026-09-20T17:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * `CL-01` and `CL-02` both read three lists as of `REQ-001`. The requests list answers empty
 * here on purpose: what the request cards do is proved in `client-requests-flow.test.tsx`, and
 * this file's subject is the two rules §6 puts on the work-item half.
 */
function portal(items: readonly unknown[], projects: readonly unknown[] = [PROJECT]): ApiClient {
  return clientOver((url) => {
    if (url.includes('/portal/work-items')) return json({ workItems: items });
    if (url.includes('/portal/requests')) return json({ requests: [] });
    // QA-FIX-O M3: My Actions also reads each project's versions awaiting the client.
    if (url.includes('/deliverables')) return json({ deliverables: [] });
    if (url.includes('/journey')) {
      return json({
        journey: { projectId: 'proj-1', steps: [], yourTurn: null, completed: false },
      });
    }
    return json({ projects });
  });
}

function renderOverview(items: readonly unknown[], projects: readonly unknown[] = [PROJECT]) {
  return render(
    withQuery(
      <ClientOverviewScreen
        organizationSlug="northstar"
        clientName="Atlas Hotels"
        providerName="Harbour Studio"
        client={portal(items, projects)}
        now={NOW}
      />,
    ),
  );
}

function renderActions(items: readonly unknown[]) {
  return render(
    withQuery(
      <ClientActionsScreen
        organizationSlug="northstar"
        clientName="Atlas Hotels"
        providerName="Harbour Studio"
        client={portal(items)}
        now={NOW}
      />,
    ),
  );
}

describe('CL-01 the client overview', () => {
  it('shows no percentage anywhere', async () => {
    renderOverview([item(), item({ id: 'wi-2', progress: 'done' })]);

    await screen.findByText(/Nothing needs you right now/);

    // §6, in bold: "No internal task percentage." Nothing on this screen may read as one.
    expect(screen.queryByText(/%/)).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('is the one door to the client inbox, since the rail was left alone', async () => {
    renderOverview([item()]);
    // The rail is `22` §1's list and has no inbox; this link is how a client reaches theirs.
    // Deleting it would strand the screen with every other suite green — the review fleet's
    // finding of 2026-09-03.
    expect(await screen.findByRole('link', { name: 'What has changed' })).toHaveAttribute(
      'href',
      '/northstar/portal/inbox',
    );
  });

  it('leads with what is waiting on the client', async () => {
    renderOverview([
      item({ id: 'wi-a', title: 'Approve the copy', progress: 'waiting_on_you' }),
      item({ id: 'wi-b', title: 'The homepage design' }),
    ]);

    // Wait for the item, not for the section: the section renders immediately with its empty
    // copy while the query is in flight, so awaiting the region resolves against the empty one.
    await screen.findByText('Approve the copy');

    const waiting = screen.getByRole('region', { name: 'Your actions' });
    expect(within(waiting).getByText('Approve the copy')).toBeInTheDocument();
    expect(within(waiting).queryByText('The homepage design')).toBeNull();
  });

  it('says nothing is waiting, and that the client will be told', async () => {
    renderOverview([item()]);

    await screen.findByText(/Nothing needs you right now/);

    const waiting = screen.getByRole('region', { name: 'Your actions' });
    expect(within(waiting).getByText(/Nothing needs you right now/)).toBeInTheDocument();
    expect(within(waiting).getByText(/will tell you as well/)).toBeInTheDocument();
  });

  it('names the agreed date and the estimate as different things', async () => {
    renderOverview([item()]);

    await screen.findByText('Agreed date');
    const dates = screen.getByRole('region', { name: 'Dates' });
    // Two labelled facts, each with its own value — never one merged "due" date.
    expect(within(dates).getByText('Agreed date')).toBeInTheDocument();
    expect(within(dates).getByText('15 Oct')).toBeInTheDocument();
    expect(within(dates).getByText('Current estimate')).toBeInTheDocument();
    expect(within(dates).getByText('29 Oct')).toBeInTheDocument();
  });

  it('names a missing agreed date as the launch date (B7)', async () => {
    renderOverview([item()], [{ ...PROJECT, committedAt: null }]);
    expect(await screen.findByText('No launch date agreed yet')).toBeInTheDocument();
  });

  it('says the plan is not shared yet rather than showing an empty list', async () => {
    renderOverview([]);

    // 52-27 empty state (Figma 606:34469) replaced the old track's "nothing shared" line.
    expect(await screen.findByText(/Your project plan will appear here/)).toBeInTheDocument();
  });

  it('renders the client’s own name, not only the provider’s', async () => {
    renderOverview([item()]);

    await screen.findByText(/Nothing needs you right now/);
    expect(screen.getAllByText(/Atlas Hotels/).length).toBeGreaterThan(0);
  });

  it('has no axe violations', async () => {
    const { container } = renderOverview([item()]);

    await screen.findByText(/Nothing needs you right now/);
    await expectNoAxeViolations(container);
  });
});

describe('CL-02 my actions', () => {
  it('lists only what is waiting on the client', async () => {
    renderActions([
      item({ id: 'wi-a', title: 'Approve the copy', progress: 'waiting_on_you' }),
      item({ id: 'wi-b', title: 'The homepage design' }),
      item({ id: 'wi-c', title: 'Finished thing', progress: 'done' }),
    ]);

    const list = await screen.findByRole('list', { name: 'Your actions' });
    expect(within(list).getByText('Approve the copy')).toBeInTheDocument();
    expect(within(list).queryByText('The homepage design')).toBeNull();
    expect(within(list).queryByText('Finished thing')).toBeNull();
  });

  it('orders by date, soonest first, with undated last', async () => {
    renderActions([
      item({
        id: 'wi-late',
        title: 'Later thing',
        progress: 'waiting_on_you',
        dueAt: '2026-10-01T00:00:00.000Z',
      }),
      item({ id: 'wi-none', title: 'Undated thing', progress: 'waiting_on_you', dueAt: null }),
      item({
        id: 'wi-soon',
        title: 'Sooner thing',
        progress: 'waiting_on_you',
        dueAt: '2026-09-05T00:00:00.000Z',
      }),
    ]);

    const list = await screen.findByRole('list', { name: 'Your actions' });
    const titles = within(list)
      .getAllByRole('listitem')
      .map((row) => row.textContent ?? '');
    expect(titles[0]).toContain('Sooner thing');
    expect(titles[1]).toContain('Later thing');
    expect(titles[2]).toContain('Undated thing');
  });

  it('marks something past its date', async () => {
    renderActions([
      item({
        id: 'wi-late',
        title: 'Overdue thing',
        progress: 'waiting_on_you',
        dueAt: '2026-08-01T00:00:00.000Z',
      }),
    ]);

    const list = await screen.findByRole('list', { name: 'Your actions' });
    expect(within(list).getByText('Past its date')).toBeInTheDocument();
  });

  it('confirms the notification behaviour when there is nothing to do', async () => {
    renderActions([item()]);

    // §6: "Empty state confirms notification behavior." Both halves — nothing is waiting, and
    // you will be told rather than expected to keep checking.
    expect(await screen.findByText('Nothing is waiting on you')).toBeInTheDocument();
    expect(screen.getByText(/you do not have to keep checking this page/)).toBeInTheDocument();
  });

  it('shows no consequence or review time it does not have', async () => {
    renderActions([item({ progress: 'waiting_on_you' })]);

    // "Why, due, consequence, estimated review time" — for a work item, two of the four are not
    // stored. The card shows the due date and nothing invented in place of the other two.
    const list = await screen.findByRole('list', { name: 'Your actions' });
    expect(within(list).getByText(/Needed by/)).toBeInTheDocument();
    expect(within(list).queryByText(/minutes|\d+m\b/)).toBeNull();
  });

  it('has no axe violations', async () => {
    const { container } = renderActions([item({ progress: 'waiting_on_you' })]);

    await screen.findByRole('list', { name: 'Your actions' });
    await expectNoAxeViolations(container);
  });
});
