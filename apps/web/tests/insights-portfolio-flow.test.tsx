import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { InsightsPortfolioScreen } from '../src/components/screens/InsightsPortfolioScreen';
import { expectNoAxeViolations } from './axe';

/**
 * INS-01 portfolio overview (x120). The screen reads one endpoint (`…/insights/portfolio`); the
 * fake fetch returns the roll-up body and status so the empty state and a refusal can be exercised
 * the way a caller actually experiences them.
 */
type Reply = { body: unknown; status?: number };

function mount(reply: Reply) {
  const routed: typeof globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    )) as typeof globalThis.fetch;

  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: routed,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={query}>
      <InsightsPortfolioScreen
        organizationSlug="northstar"
        organizationName="Northstar Studio"
        client={client}
      />
    </QueryClientProvider>,
  );
}

function flow(over: { blocked?: number; itemCount?: number } = {}) {
  return {
    projectId: 'ignored',
    counts: {
      backlog: 1,
      ready: 0,
      in_progress: 2,
      blocked: over.blocked ?? 0,
      internal_review: 0,
      done: 1,
      archived: 0,
    },
    itemCount: over.itemCount ?? 4,
    computedAt: '2026-09-20T10:00:00.000Z',
  };
}

function cycle(changesRequested: number) {
  return {
    projectId: 'ignored',
    metrics: {
      approved: { count: 2, decidedCount: 2, totalDurationMs: 0 },
      changes_requested: {
        count: changesRequested,
        decidedCount: changesRequested,
        totalDurationMs: 0,
      },
      invalidated: { count: 0, decidedCount: 0, totalDurationMs: 0 },
    },
    approvalCount: 2 + changesRequested,
    computedAt: '2026-09-20T10:00:00.000Z',
  };
}

const PORTFOLIO = {
  projects: [
    {
      projectId: 'project-1',
      name: 'Rebrand',
      deliveryFlow: flow({ blocked: 3, itemCount: 7 }),
      approvalCycle: cycle(2),
    },
    {
      projectId: 'project-2',
      name: 'Website',
      deliveryFlow: flow({ blocked: 0, itemCount: 4 }),
      approvalCycle: cycle(0),
    },
  ],
  projectCount: 2,
  computedAt: '2026-09-20T10:00:00.000Z',
};

const EMPTY = { projects: [], projectCount: 0, computedAt: '2026-09-20T10:00:00.000Z' };

function refusal(message: string) {
  return { body: { error: { code: 'forbidden', message, correlationId: 'c' } }, status: 403 };
}

describe('InsightsPortfolioScreen', () => {
  it('renders each accessible project with its headline figures and a drill-in link', async () => {
    const { container } = mount({ body: PORTFOLIO });

    const table = (await screen.findByRole('table', {
      name: /projects by headline insight figures/i,
    })) as HTMLTableElement;
    // Rebrand: 7 work items, 3 blocked, 2 changes requested.
    expect(within(table).getByRole('row', { name: /Rebrand 7 3 2/i })).toBeTruthy();
    expect(within(table).getByRole('row', { name: /Website 4 0 0/i })).toBeTruthy();

    const link = screen.getByRole('link', { name: 'Rebrand' });
    expect(link.getAttribute('href')).toBe('/northstar/insights/projects/project-1');

    await expectNoAxeViolations(container);
  });

  it('shows an empty portfolio plainly — no invented projects', async () => {
    mount({ body: EMPTY });

    expect(await screen.findByText(/No projects you can read have insights yet/i)).toBeTruthy();
  });

  it('surfaces a work.read refusal rather than a blank page', async () => {
    mount(refusal('You need work.read.'));

    expect(await screen.findByText('You need work.read.')).toBeTruthy();
  });
});
