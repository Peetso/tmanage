import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import type { Timesheet } from '../src/lib/api/finance-core';
import { UnassignedTimeList } from '../src/components/time/UnassignedTimeList';
import { formatDuration, timeZoneCity } from '../src/lib/i18n/duration';

/**
 * Live check items 2, 8 and 10 — the timesheet's unassigned time has real actions (put it on a
 * task, all or part; delete), automatic entries are marked, and durations read in the language.
 */

const SHEET: Timesheet = {
  id: 'ts1',
  membershipId: 'm1',
  periodStart: '2026-11-09',
  periodEnd: '2026-11-15',
  days: ['2026-11-09'],
  state: 'open',
  version: 1,
  decisionNote: null,
  totalMinutes: 60,
  billableMinutes: 60,
  locked: false,
  groups: [
    {
      projectId: null,
      workItemId: null,
      title: null,
      minutes: 60,
      entries: [
        {
          id: 'e1',
          title: null,
          spentOn: '2026-11-09',
          minutes: 60,
          billable: true,
          needsReview: false,
          source: 'automatic',
        },
      ],
    },
  ],
};

interface Call {
  method: string;
  url: string;
  body?: string;
}

function setup(sheet: Timesheet = SHEET) {
  const calls: Call[] = [];
  const api = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = { method: init?.method ?? 'GET', url: String(input) };
      if (typeof init?.body === 'string') call.body = init.body;
      calls.push(call);
      const body = call.url.includes('/work-items')
        ? { workItems: [{ id: 'w1', title: 'Homepage copy', deletedAt: null }] }
        : sheet;
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={query}>
      <UnassignedTimeList api={api} organizationSlug="northstar" sheet={sheet} />
    </QueryClientProvider>,
  );
  return calls;
}

describe('unassigned time on the timesheet', () => {
  it('marks automatic time and splits part of it onto a task the person can see', async () => {
    const calls = setup();
    const table = screen.getByRole('table', { name: 'Unassigned time' });
    expect(table).toHaveTextContent('Automatic');
    expect(table).toHaveTextContent('1h');
    fireEvent.click(within(table).getByRole('button', { name: 'Put on a task' }));
    const task = await screen.findByRole('combobox', { name: 'Task' });
    await waitFor(() => expect(within(task).getAllByRole('option')).toHaveLength(2));
    fireEvent.change(task, { target: { value: 'w1' } });
    fireEvent.change(screen.getByLabelText(/Minutes to put on it/), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Put it on the task' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/entries/split'))).toBe(true));
    const split = calls.find((c) => c.url.endsWith('/entries/split'));
    expect(JSON.parse(split?.body ?? '{}')).toEqual({
      entryId: 'e1',
      minutes: 20,
      workItemId: 'w1',
    });
  });

  it('files all of it with a move, and deletes only after a confirm', async () => {
    const calls = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Put on a task' }));
    const task = await screen.findByRole('combobox', { name: 'Task' });
    await waitFor(() => expect(within(task).getAllByRole('option')).toHaveLength(2));
    fireEvent.change(task, { target: { value: 'w1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Put it on the task' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/entries/move'))).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(calls.some((c) => c.url.endsWith('/entries/delete'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Delete time' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/entries/delete'))).toBe(true));
    const remove = calls.find((c) => c.url.endsWith('/entries/delete'));
    expect(JSON.parse(remove?.body ?? '{}')).toEqual({ entryIds: ['e1'] });
  });

  it('offers no actions on a week that cannot change', () => {
    setup({ ...SHEET, state: 'approved' });
    expect(screen.queryByRole('button', { name: 'Put on a task' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });
});

describe('durations and zones in the reader’s language (item 10)', () => {
  it('has no Latin "m" in Arabic, and the right plural', () => {
    expect(formatDuration(45, 'en')).toBe('45m');
    expect(formatDuration(330, 'en')).toBe('5h 30m');
    const arabic = formatDuration(5, 'ar');
    expect(arabic).toContain('دقائق');
    expect(arabic).not.toMatch(/[a-z]/u);
    expect(timeZoneCity('Africa/Cairo', 'ar')).toBe('القاهرة');
    expect(timeZoneCity('America/New_York', 'en')).toBe('New York');
  });
});
