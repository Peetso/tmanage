import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { InsightsPortfolioScreen } from '../src/components/screens/InsightsPortfolioScreen';
import { expectNoAxeViolations } from './axe';

/**
 * INS-01 portfolio overview (x120). The screen reads one endpoint (`…/insights/portfolio`); the
 * fake fetch returns the roll-up body and status so the empty state and a refusal can be exercised
 * the way a caller actually experiences them.
 */
type Reply = { body: unknown; status?: number };

function mount(reply: Reply | ((url: string) => Reply), seen: string[] = []) {
  const routed: typeof globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    const answer = typeof reply === 'function' ? reply(url) : reply;
    return Promise.resolve(
      new Response(JSON.stringify(answer.body), {
        status: answer.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof globalThis.fetch;

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

  describe('A13 — Projects in this report', () => {
    afterEach(() => window.history.replaceState(null, '', '/'));

    /** The roll-up narrowed the way the server narrows it: only the requested ids. */
    function filtering(url: string): Reply {
      const ids = new URL(url).searchParams.get('projectIds');
      if (!ids) return { body: PORTFOLIO };
      const keep = ids.split(',');
      const projects = PORTFOLIO.projects.filter((p) => keep.includes(p.projectId));
      return { body: { ...PORTFOLIO, projects, projectCount: projects.length } };
    }

    it('narrows the report to the checked projects and writes them to the URL', async () => {
      const seen: string[] = [];
      mount(filtering, seen);

      fireEvent.click(await screen.findByRole('button', { name: /2/ }));
      const picker = screen.getByRole('dialog');
      fireEvent.click(within(picker).getByRole('checkbox', { name: 'Website' }));
      expect(
        (within(picker).getByRole('checkbox', { name: 'All projects' }) as HTMLInputElement)
          .checked,
      ).toBe(false);
      fireEvent.click(within(picker).getByRole('button', { name: 'Show 1 project' }));

      expect(await screen.findByRole('link', { name: 'Website' })).toBeTruthy();
      expect(screen.queryByRole('link', { name: 'Rebrand' })).toBeNull();
      expect(seen.some((url) => url.endsWith('/insights/portfolio?projectIds=project-2'))).toBe(
        true,
      );
      expect(new URLSearchParams(window.location.search).get('projects')).toBe('project-2');
    });

    it('reads ?projects= on load, and Clear + Show all returns to every project', async () => {
      window.history.replaceState(null, '', '/northstar/insights?projects=project-1');
      const seen: string[] = [];
      mount(filtering, seen);

      expect(await screen.findByRole('link', { name: 'Rebrand' })).toBeTruthy();
      await waitFor(() => expect(screen.queryByRole('link', { name: 'Website' })).toBeNull());
      expect(seen.some((url) => url.endsWith('?projectIds=project-1'))).toBe(true);

      fireEvent.click(screen.getByRole('button', { name: /1/ }));
      const picker = screen.getByRole('dialog');
      fireEvent.click(within(picker).getByRole('button', { name: 'Clear' }));
      fireEvent.click(within(picker).getByRole('button', { name: 'Show all projects' }));

      expect(await screen.findByRole('link', { name: 'Website' })).toBeTruthy();
      expect(window.location.search).toBe('');
    });
  });
});
