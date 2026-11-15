import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { BudgetBurnPanel } from '../src/components/projects/BudgetBurnPanel';
import { pickPortalProject } from '../src/components/shell/PortalProjectSwitcher';

/**
 * Live check on deploy 38bab83c: logged time did not reach the overview's "Budget burn" (the panel
 * read the swept cache, 0 on a project with no budget row), and the client preview showed the
 * first shared project whatever `?project=` named.
 */

const BASE = 'https://api.test';

function fakeApi(bodies: Record<string, unknown>): ApiClient {
  return new ApiClient({
    baseUrl: BASE,
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL) => {
      const url = String(input);
      const key = Object.keys(bodies).find((path) => url.includes(path));
      return Promise.resolve(
        new Response(JSON.stringify(key ? bodies[key] : {}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
}

describe('BudgetBurnPanel — logged time', () => {
  it('shows the live logged total even when the cache is still 0', async () => {
    const api = fakeApi({
      '/budget/burn': {
        projectId: 'p1',
        from: '2026-08-24',
        to: '2026-11-15',
        groupBy: 'week',
        buckets: [],
        nextCursor: null,
        forecastExhaustedOn: null,
      },
      '/budget': {
        projectId: 'p1',
        budgetHours: null,
        trackedHours: 7.58,
        remainingHours: null,
        varianceHours: null,
        updatedAt: null,
        budgetType: 'hours',
        includeExpenses: true,
        clientVisible: false,
        alertThresholds: [],
        phases: [],
        usedHoursCache: 0,
        cacheRefreshedAt: null,
        burn: null,
      },
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <BudgetBurnPanel api={api} organizationSlug="atlas" projectId="p1" today="2026-11-15" />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/7\.6 h logged/u)).toBeInTheDocument();
  });
});

describe('pickPortalProject', () => {
  const projects = [
    { id: 'p-arabic', name: 'مشروع' },
    { id: 'p-harbor', name: 'Harbor Hotel Website' },
  ];

  it('shows the project the address names, not the first one shared', () => {
    expect(pickPortalProject(projects, 'p-harbor')?.name).toBe('Harbor Hotel Website');
  });

  it('falls back to the first shared project, and never to an id outside the list', () => {
    expect(pickPortalProject(projects, null)?.id).toBe('p-arabic');
    expect(pickPortalProject(projects, 'not-shared')?.id).toBe('p-arabic');
    expect(pickPortalProject(undefined, 'p-harbor')).toBeUndefined();
  });
});
