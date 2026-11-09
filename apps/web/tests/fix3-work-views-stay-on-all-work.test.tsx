import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WorkWorkloadScreen } from '../src/components/screens/WorkWorkloadScreen';
import { ApiClient } from '../src/lib/api/client';

/**
 * FIX3 item 10 (live check a6f66e47): Workload, Timeline and Calendar stayed on "All work" in List
 * and Board but switched to the first project here on their own. With no project chosen the view
 * now reads every project and keeps "All work" as its scope. Workload stands in for the three: the
 * same rule and the same per-project fan-out (`getWork*All`) drive each.
 */

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('work views stay on All work (FIX3 item 10)', () => {
  it('reads every project and keeps All work selected', async () => {
    const urls: string[] = [];
    const client = new ApiClient({
      baseUrl: 'https://api.example.test',
      csrfCookieName: 'tm_session_csrf',
      fetch: ((input: RequestInfo | URL) => {
        const url = String(input);
        urls.push(url);
        if (url.includes('/work-views/workload/p1')) {
          return Promise.resolve(
            json({
              projectId: 'p1',
              groups: [{ ownerUserId: 'u1', openItemCount: 2, scheduledItemCount: 1 }],
            }),
          );
        }
        if (url.includes('/work-views/workload/p2')) {
          return Promise.resolve(
            json({
              projectId: 'p2',
              groups: [{ ownerUserId: 'u1', openItemCount: 3, scheduledItemCount: 2 }],
            }),
          );
        }
        if (url.includes('/projects')) {
          return Promise.resolve(
            json({
              projects: [
                { id: 'p1', name: 'Atlas' },
                { id: 'p2', name: 'Borealis' },
              ],
            }),
          );
        }
        return Promise.resolve(json({ members: [], nextAfter: null }));
      }) as typeof globalThis.fetch,
      readCsrfToken: () => 'csrf-token',
      newCorrelationId: () => 'correlation-fixed',
    });
    const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={query}>
        <WorkWorkloadScreen organizationSlug="acme" organizationName="Acme" client={client} />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(urls.some((url) => url.includes('/work-views/workload/p1'))).toBe(true);
      expect(urls.some((url) => url.includes('/work-views/workload/p2'))).toBe(true);
    });
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(select.selectedOptions[0]?.textContent).toBe('All work');
    // One row for the person, with both projects' open work summed.
    expect(await screen.findByText(/^5 /)).toBeTruthy();
  });
});
