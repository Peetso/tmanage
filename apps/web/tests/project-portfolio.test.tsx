import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ProjectPortfolioScreen } from '../src/components/screens/ProjectPortfolioScreen';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * **Project portfolio (x137).**
 *
 * The tenant-scoping, the relation filter and the aggregates are proved over fakes and (in the chain)
 * a real server in `apps/api/src/modules/projects/portfolio.controller.test.ts`; nothing here
 * re-proves them.
 *
 * What only this file can prove is what the *screen* does: it renders the server's order without
 * re-sorting, folds each project's counts into a card, shows the empty state plainly, and carries an
 * accessible list of cards (labelled regions, headings, detail lists) with no axe violation jsdom can
 * detect.
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

function summary(projectId: string, name: string, over: Record<string, unknown> = {}) {
  return {
    projectId,
    name,
    status: 'active',
    openWorkCount: 0,
    objectiveCounts: { open: 0, met: 0, missed: 0 },
    latestActivityAt: null,
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

describe('ProjectPortfolioScreen', () => {
  it('renders one card per project in server order and is accessible', async () => {
    const client = clientOver((call) => {
      if (call.url.includes('/projects/portfolio'))
        return json({
          projects: [
            summary('p-1', 'First project', {
              openWorkCount: 3,
              objectiveCounts: { open: 2, met: 1, missed: 0 },
              latestActivityAt: '2026-03-01T09:00:00.000Z',
            }),
            summary('p-2', 'Second project'),
          ],
        });
      return json({ projects: [] });
    });

    const { container } = renderScreen(client);

    const headings = await screen.findAllByRole('heading', { level: 3 });
    expect(headings.map((h) => h.textContent)).toEqual(['First project', 'Second project']);
    // The first card shows its folded counts.
    const firstCard = screen.getByRole('link', { name: 'First project' }).closest('article');
    expect(firstCard).not.toBeNull();
    expect(within(firstCard as HTMLElement).getByText('3')).toBeInTheDocument();
    expect(
      within(firstCard as HTMLElement).getByText('2 open, 1 met, 0 missed'),
    ).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('shows the empty state when the caller can see no project', async () => {
    const client = clientOver(() => json({ projects: [] }));
    renderScreen(client);
    expect(await screen.findByText('No projects yet')).toBeInTheDocument();
  });
});
