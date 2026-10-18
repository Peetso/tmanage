import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ProjectPortfolioScreen } from '../src/components/screens/ProjectPortfolioScreen';
import { ApiClient } from '../src/lib/api/client';
import type { ProjectPortfolioSummary } from '../src/lib/api/project-portfolio';
import { buildTimeline, describeRow } from '../src/lib/portfolio-presentation';
import { expectNoAxeViolations } from './axe';

/**
 * **Project portfolio (x137).**
 *
 * The tenant-scoping, the relation filter and the aggregates are proved over fakes and (in the chain)
 * a real server in `apps/api/src/modules/projects/portfolio.controller.test.ts`; nothing here
 * re-proves them.
 *
 * What only this file can prove is what the *screen* does: exception-first rows with the COMMITTED /
 * FORECAST / CLIENT WAIT columns (POR-01), the timeline bars (POR-02), the capacity panel (POR-03),
 * the empty state, and no axe violation jsdom can detect.
 */

interface Call {
  readonly url: string;
  readonly method: string;
}

function clientOver(handler: (call: Call) => Response): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(
        handler({ url: String(input), method: (init?.method ?? 'GET').toUpperCase() }),
      )) as typeof globalThis.fetch,
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

function summary(
  projectId: string,
  name: string,
  over: Partial<ProjectPortfolioSummary> = {},
): ProjectPortfolioSummary {
  return {
    projectId,
    name,
    status: 'active',
    openWorkCount: 0,
    objectiveCounts: { open: 0, met: 0, missed: 0 },
    latestActivityAt: null,
    committedOn: null,
    forecastOn: null,
    clientName: null,
    ownerName: null,
    clientWaitSince: null,
    startedOn: '2026-09-01',
    archivedAt: null,
    milestones: [],
    ...over,
  };
}

function renderScreen(client: ApiClient) {
  return render(
    withQuery(
      <ProjectPortfolioScreen
        organizationSlug="northstar"
        organizationName="Northstar"
        client={client}
      />,
    ),
  );
}

const CAPACITY = {
  weekStart: '2026-10-12',
  disciplines: [
    { discipline: 'Design', members: 2, capacityHours: 80, allocatedHours: 94.4, loadPercent: 118 },
    {
      discipline: 'Engineering',
      members: 2,
      capacityHours: 80,
      allocatedHours: 51.2,
      loadPercent: 64,
    },
  ],
  unstaffed: {
    total: 1,
    items: [
      {
        workItemId: 'w-1',
        title: 'Accessibility pass',
        projectId: 'p-1',
        projectName: 'Atlas Relaunch',
        dueOn: '2026-10-20',
      },
    ],
  },
  constraint: { discipline: 'Design', loadPercent: 118, internalDatesThisWeek: 2 },
};

describe('ProjectPortfolioScreen', () => {
  it('puts a slipped project first with its committed, forecast and client-wait columns', async () => {
    const client = clientOver((call) => {
      if (call.url.includes('/projects/portfolio/capacity')) return json(CAPACITY);
      return json({
        projects: [
          summary('p-1', 'Holding project', { committedOn: '2099-01-10', clientName: 'Atlas' }),
          summary('p-2', 'Slipped project', {
            committedOn: '2099-01-01',
            forecastOn: '2099-01-05',
            clientName: 'Meridian',
            ownerName: 'Karim Nabil',
            clientWaitSince: new Date(Date.now() - 5 * 24 * 3600e3).toISOString(),
          }),
        ],
      });
    });

    const { container } = renderScreen(client);

    const headings = await screen.findAllByRole('heading', { level: 3 });
    expect(headings.slice(0, 2).map((h) => h.textContent)).toEqual([
      'Slipped project',
      'Holding project',
    ]);
    const slipped = screen.getByRole('link', { name: 'Slipped project' }).closest('article');
    const row = within(slipped as HTMLElement);
    expect(row.getByText('Forecast is 4 days past the commitment')).toBeInTheDocument();
    expect(row.getByText('1 Jan')).toBeInTheDocument();
    expect(row.getByText('5 Jan')).toBeInTheDocument();
    expect(row.getByText('5d')).toBeInTheDocument();
    expect(row.getByText('Meridian · Karim Nabil')).toBeInTheDocument();
    expect(screen.getByText('One project needs a decision')).toBeInTheDocument();

    // POR-03: the over-capacity discipline and the unstaffed commitment, from the capacity read.
    expect(await screen.findByRole('meter', { name: 'Design load' })).toHaveAttribute(
      'aria-valuetext',
      '118% of 80 hours',
    );
    expect(screen.getByRole('link', { name: 'Accessibility pass' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Design is the portfolio constraint. The lever is moving two internal-only dates, not asking one person for more hours.',
      ),
    ).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('shows the capacity refusal as a sentence, not a blank panel', async () => {
    const client = clientOver((call) =>
      call.url.includes('/capacity')
        ? json({ error: { code: 'forbidden', message: 'You do not have permission' } }, 403)
        : json({ projects: [summary('p-1', 'Only project')] }),
    );
    renderScreen(client);
    expect(await screen.findByText('Could not load capacity')).toBeInTheDocument();
  });

  it('shows the empty state when the caller can see no project', async () => {
    const client = clientOver(() => json({ projects: [] }));
    renderScreen(client);
    expect(await screen.findByText('No projects yet')).toBeInTheDocument();
  });
});

describe('portfolio presentation', () => {
  const NOW = Date.UTC(2026, 9, 18, 12);

  it('draws held, slipped and not-started bars and names the busiest month', () => {
    const timeline = buildTimeline(
      [
        summary('a', 'Atlas Relaunch', {
          committedOn: '2026-10-30',
          clientName: 'Atlas',
          startedOn: '2026-09-04',
          milestones: [
            { title: 'Sign-off', dueOn: '2026-09-12', status: 'met', published: true },
            { title: 'Launch', dueOn: '2026-10-30', status: 'planned', published: true },
          ],
        }),
        summary('m', 'Meridian App', {
          committedOn: '2026-10-26',
          forecastOn: '2026-10-29',
          clientName: 'Meridian',
          startedOn: '2026-09-08',
        }),
        summary('n', 'Northwind', { committedOn: '2026-12-27', startedOn: '2026-11-10' }),
        summary('x', 'Archived', { status: 'archived', committedOn: '2026-10-01' }),
      ],
      NOW,
    );
    expect(timeline.range).toBe('SEP — DEC 2026');
    expect(timeline.rows.map((r) => [r.name, r.variant, r.chipLabel, r.chipDate])).toEqual([
      ['Meridian App', 'slipped', 'SLIPPED', '29 OCT'],
      ['Atlas Relaunch', 'client', 'LAUNCH', '30 OCT'],
      ['Northwind', 'future', null, '27 DEC'],
    ]);
    expect(timeline.rows[1]!.metAt).toHaveLength(1);
    expect(timeline.summary).toBe(
      'October carries one client-facing date and the Meridian slip — the portfolio constraint is October, not any one project',
    );
  });

  it('treats a date with no float as amber and an untracked project as plain', () => {
    expect(
      describeRow(summary('a', 'A', { committedOn: '2026-10-25', forecastOn: '2026-10-25' }), NOW),
    ).toMatchObject({ tone: 'warning', why: 'No float left before the committed date moves' });
    expect(describeRow(summary('b', 'B'), NOW)).toMatchObject({
      tone: 'neutral',
      why: 'No active milestone — not a risk, but not tracked either',
    });
  });
});
