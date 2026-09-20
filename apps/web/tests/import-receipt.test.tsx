import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

/** Read a summary `<dd>` by its `<dt>` term — the word "Failed" also appears as a row capsule. */
function summaryValue(container: HTMLElement, term: string): string | undefined {
  const pairs = Array.from(container.querySelectorAll('.tm-detail-list__pair'));
  const pair = pairs.find((p) => p.querySelector('dt')?.textContent?.trim() === term);
  return pair?.querySelector('dd')?.textContent?.trim();
}
import { ApiClient } from '../src/lib/api/client';
import { ImportReceiptScreen } from '../src/components/screens/ImportReceiptScreen';
import { expectNoAxeViolations } from './axe';

/** ON-09 / ADM-10 receipt read (x104) — the Import Receipt screen. */
function mount(body: unknown, status = 200) {
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: (() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      )) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={query}>
      <ImportReceiptScreen
        organizationSlug="northstar"
        organizationName="Northstar Studio"
        jobId="00000000-0000-4000-8000-000000000001"
        client={client}
      />
    </QueryClientProvider>,
  );
}

describe('ImportReceiptScreen', () => {
  it('renders the status, counts and the per-row list in source order, with no a11y violations', async () => {
    const { container } = mount({
      jobId: '00000000-0000-4000-8000-000000000001',
      sourceKind: 'project',
      status: 'committed_with_errors',
      committedCount: 2,
      failedCount: 1,
      rows: [
        { sourceIndex: 0, outcome: 'created', createdEntityId: 'proj-a', error: null },
        {
          sourceIndex: 1,
          outcome: 'failed',
          createdEntityId: null,
          error: 'name: must be a non-empty string',
        },
        { sourceIndex: 2, outcome: 'created', createdEntityId: 'proj-c', error: null },
      ],
    });

    expect(await screen.findByText('Committed with errors')).toBeTruthy();

    // The status and the two summary figures, read by their term so the row capsules do not clash.
    expect(summaryValue(container, 'Status')).toContain('Committed with errors');
    expect(summaryValue(container, 'Committed')).toBe('2');
    expect(summaryValue(container, 'Failed')).toBe('1');

    // One row per source row, in source order (the row header shows the 1-based index).
    const rows = screen.getAllByRole('row').slice(1); // drop the header row
    expect(rows).toHaveLength(3);
    expect(within(rows[0] as HTMLElement).getByRole('rowheader').textContent).toBe('1');
    expect(within(rows[1] as HTMLElement).getByRole('rowheader').textContent).toBe('2');
    expect(within(rows[2] as HTMLElement).getByRole('rowheader').textContent).toBe('3');

    // The failed row shows its error; a created row shows the created id.
    expect(screen.getByText('name: must be a non-empty string')).toBeTruthy();
    expect(screen.getByText('proj-a')).toBeTruthy();
    expect(screen.getByText('proj-c')).toBeTruthy();

    await expectNoAxeViolations(container);
  });

  it('renders an all-committed job with zero failures', async () => {
    const { container } = mount({
      jobId: '00000000-0000-4000-8000-000000000001',
      sourceKind: 'project',
      status: 'committed',
      committedCount: 1,
      failedCount: 0,
      rows: [{ sourceIndex: 0, outcome: 'created', createdEntityId: 'proj-a', error: null }],
    });

    await screen.findByRole('table');
    expect(summaryValue(container, 'Status')).toContain('Committed');
    expect(summaryValue(container, 'Committed')).toBe('1');
    expect(summaryValue(container, 'Failed')).toBe('0');
  });

  it('renders the API refusal rather than a blank page', async () => {
    mount({ error: { code: 'forbidden', message: 'No access.', correlationId: 'c' } }, 403);
    await waitFor(() => expect(screen.getByText('No access.')).toBeTruthy());
  });

  it('renders a not-found receipt as an error line, not a blank page', async () => {
    mount(
      { error: { code: 'not_found', message: 'The requested resource was not found', correlationId: 'c' } },
      404,
    );
    await waitFor(() =>
      expect(screen.getByText('The requested resource was not found')).toBeTruthy(),
    );
  });
});
