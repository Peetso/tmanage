import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkCalendarScreen } from '../src/components/screens/WorkCalendarScreen';
import { ApiClient } from '../src/lib/api/client';
import {
  calendarGrid,
  calendarRangeProblem,
  calendarRangeTitle,
  shiftCalendarMonth,
} from '../src/lib/work-calendar-range';

/**
 * WK-05 custom From/To range. The API's own range validation and the `work.read` gate are proved
 * in `calendar-range.test.ts` and the work-views service test; this file proves the screen's
 * rules match them and that the screen sends only a valid range and reports it for the URL.
 */

const NOW = new Date('2026-08-14T10:00:00.000Z');

function screenWith(props: { initialFrom?: string; initialTo?: string }) {
  const urls: string[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      const body = url.includes('/work-views/calendar/')
        ? { projectId: 'proj-1', range: { from: '', to: '' }, days: [] }
        : { projects: [{ id: 'proj-1', name: 'Atlas' }] };
      return Promise.resolve(
        new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
  const onRangeChange = vi.fn();
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queries}>
      <WorkCalendarScreen
        organizationSlug="acme"
        organizationName="Acme"
        client={client}
        now={NOW}
        onRangeChange={onRangeChange}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { urls, onRangeChange };
}

describe('work calendar range rules', () => {
  it('matches the API: real days, ordered, at most 366 days', () => {
    expect(calendarRangeProblem({ from: '2026-08-12', to: '2026-09-03' })).toBeNull();
    expect(calendarRangeProblem({ from: '2026-02-31', to: '2026-03-05' })).toMatch(/From/);
    expect(calendarRangeProblem({ from: '2026-09-03', to: '2026-08-12' })).toMatch(/on or after/);
    expect(calendarRangeProblem({ from: '2024-01-01', to: '2025-01-01' })).toMatch(/366/);
  });

  it('titles and grids a custom range across months, and month nav returns to whole months', () => {
    const range = { from: '2026-08-12', to: '2026-09-03' };
    expect(calendarRangeTitle(range)).toBe('12 Aug – 3 Sep 2026');
    expect(calendarRangeTitle({ from: '2026-08-01', to: '2026-08-31' })).toBe('August 2026');
    const cells = calendarGrid(range).flat();
    expect(cells[0]?.key).toBe('2026-08-09'); // the Sunday before
    expect(cells.find((cell) => cell.key === '2026-09-01')?.label).toBe('1 Sep');
    expect(cells.filter((cell) => cell.inRange)).toHaveLength(23);
    expect(shiftCalendarMonth(range, 1, NOW)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
  });
});

describe('WorkCalendarScreen custom range', () => {
  it('queries the API with the URL range and reports edits for the URL', async () => {
    const { urls, onRangeChange } = screenWith({
      initialFrom: '2026-08-12',
      initialTo: '2026-09-03',
    });
    await waitFor(() =>
      expect(urls.some((url) => url.includes('from=2026-08-12&to=2026-09-03'))).toBe(true),
    );
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-09-10' } });
    expect(onRangeChange).toHaveBeenLastCalledWith({ from: '2026-08-12', to: '2026-09-10' });
    fireEvent.click(screen.getByRole('button', { name: 'This month' }));
    expect(onRangeChange).toHaveBeenLastCalledWith(null);
  });

  it('explains a reversed range and never sends it', async () => {
    const { urls, onRangeChange } = screenWith({
      initialFrom: '2026-09-03',
      initialTo: '2026-08-12',
    });
    expect(await screen.findByText('To must be on or after From.')).toBeInTheDocument();
    await waitFor(() => expect(urls.some((url) => url.includes('/projects'))).toBe(true));
    expect(urls.some((url) => url.includes('/work-views/calendar/'))).toBe(false);
    expect(onRangeChange).not.toHaveBeenCalled();
  });
});
