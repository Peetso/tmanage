import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { WorkWorkloadScreen } from '../src/components/screens/WorkWorkloadScreen';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * **WK-06 Work workload (x99).**
 *
 * The grouping, counts and ordering are proved over fakes in
 * `apps/api/src/modules/work-views/work-views.service.test.ts`; nothing here re-proves them.
 *
 * What only this file can prove is what the *screen* does with the answer: it renders the server's
 * order without re-sorting, names the unassigned pile in words rather than as a blank id, shows the
 * per-assignee counts, and carries the same accessible-list structure the timeline does (a labelled
 * region, a caption, column headers) with no axe violation jsdom can detect.
 */

interface Call {
  readonly url: string;
}

function clientOver(handler: (call: Call) => Response): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL) =>
      Promise.resolve(handler({ url: String(input) }))) as typeof globalThis.fetch,
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

const PROJECT_ID = 'proj-1';
const OWNER_A = 'user-0000-0000-0000-0000-0000000000aa';

function screenOver(workload: unknown) {
  const client = clientOver((call) => {
    if (call.url.includes('/work-views/workload/')) return json(workload);
    if (call.url.includes('/projects')) return json({ projects: [] });
    return json({}, 404);
  });
  return withQuery(
    <WorkWorkloadScreen
      organizationSlug="acme"
      organizationName="Acme"
      initialProjectId={PROJECT_ID}
      client={client}
    />,
  );
}

describe('WorkWorkloadScreen', () => {
  it('renders the server order with counts, names the unassigned pile, and is accessible', async () => {
    const { container } = render(
      screenOver({
        projectId: PROJECT_ID,
        groups: [
          { ownerUserId: OWNER_A, openItemCount: 3, scheduledItemCount: 2 },
          { ownerUserId: null, openItemCount: 1, scheduledItemCount: 0 },
        ],
      }),
    );

    // The labelled region — and its table — appear once the read resolves.
    const region = await screen.findByRole('region', { name: /work workload/i });
    const table = within(region).getByRole('table');
    const bodyRows = within(table).getAllByRole('row').slice(1); // drop the header row
    expect(bodyRows).toHaveLength(2);

    // Server order is preserved: the heavier owner leads, the unassigned pile trails.
    expect(within(bodyRows[0]!).getByRole('rowheader')).toHaveTextContent(OWNER_A);
    const unassigned = within(bodyRows[1]!).getByRole('rowheader');
    expect(unassigned).toHaveTextContent('Unassigned');

    // The counts are shown.
    expect(within(bodyRows[0]!).getAllByRole('cell')[0]).toHaveTextContent('3');
    expect(within(bodyRows[0]!).getAllByRole('cell')[1]).toHaveTextContent('2');

    await expectNoAxeViolations(container);
  });

  it('shows the empty state when no assignee carries open work', async () => {
    render(screenOver({ projectId: PROJECT_ID, groups: [] }));

    expect(await screen.findByText(/no open work items you can see/i)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
