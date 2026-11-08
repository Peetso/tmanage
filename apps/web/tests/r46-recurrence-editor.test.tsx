import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { WorkItemRecurrencePanel } from '../src/components/screens/WorkItemRecurrencePanel';
import { draftErrors, draftOf, inputOf } from '../src/components/screens/recurrence-draft';
import type { WorkItemRecurrence } from '../src/lib/api/work-item-recurrence';

/** r46 · 53-09 — the repeat rules editor (Figma 587:33551). */

const RULE: WorkItemRecurrence = {
  workItemId: 'wi-1',
  freq: 'weekly',
  interval: 2,
  until: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,WE;COUNT=10',
  startsOn: '2026-11-01',
  byWeekday: ['SU', 'WE'],
  byMonthDay: null,
  bySetPos: null,
  countLimit: 10,
  timeZone: null,
  spawnMode: 'on_schedule',
  spawnAheadDays: 3,
  holidayPolicy: 'next_working_day',
  status: 'active',
  ownerUserId: 'u-1',
  lastOccurrenceKey: null,
  nextDates: [],
};

describe('recurrence draft', () => {
  it('builds the v2 body: weekly days in order, monthly nth weekday, scope only when editing', () => {
    const weekly = { ...draftOf(null, '2026-11-04'), weekdays: ['WE', 'SU'] as const };
    expect(inputOf({ ...weekly, weekdays: ['WE', 'SU'] }, false)).toMatchObject({
      freq: 'WEEKLY',
      byWeekday: ['SU', 'WE'],
      byMonthDay: null,
    });
    expect(inputOf({ ...weekly, weekdays: ['SU'] }, false)).not.toHaveProperty('scope');
    const nth = { ...weekly, freq: 'MONTHLY' as const, monthlyMode: 'nth' as const, nthPos: -1 };
    expect(inputOf(nth, true)).toMatchObject({
      byWeekday: ['WE'],
      bySetPos: -1,
      byMonthDay: null,
      scope: 'this_and_future',
    });
  });

  it('refuses a weekly rule with no day, a count over 365 and an interval of 0', () => {
    const base = draftOf(null, '2026-11-04');
    expect(draftErrors({ ...base, weekdays: [] })).toHaveProperty('weekdays');
    expect(draftErrors({ ...base, endMode: 'count', count: '366' })).toHaveProperty('count');
    expect(inputOf({ ...base, interval: '0' }, false)).toBeNull();
  });

  it('seeds the editor from a saved rule', () => {
    expect(draftOf(RULE, '2026-11-04')).toMatchObject({
      freq: 'WEEKLY',
      interval: '2',
      weekdays: ['SU', 'WE'],
      endMode: 'count',
      count: '10',
      spawnAheadDays: '3',
    });
  });
});

describe('WorkItemRecurrencePanel', () => {
  it('shows the next 5 dates of the draft (a moved one flagged) and pauses the series', async () => {
    const calls: string[] = [];
    const reply = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const client = new ApiClient({
      baseUrl: 'https://api.example.test',
      csrfCookieName: 'tm_session_csrf',
      fetch: ((url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push(`${method} ${new URL(url).pathname}`);
        if (method === 'POST' && url.endsWith('/recurrence/preview')) {
          return Promise.resolve(
            reply({
              workItemId: 'wi-1',
              occurrences: [
                { key: '2026-11-15', date: '2026-11-15' },
                { key: '2026-11-18', date: '2026-11-18' },
                { key: '2026-11-29', date: '2026-11-30' },
                { key: '2026-12-02', date: '2026-12-02' },
                { key: '2026-12-13', date: '2026-12-13' },
              ],
            }),
          );
        }
        if (method === 'POST' && url.endsWith('/recurrence/pause')) {
          return Promise.resolve(reply({ ...RULE, status: 'paused' }));
        }
        return Promise.resolve(reply({ recurrence: RULE }));
      }) as typeof globalThis.fetch,
      readCsrfToken: () => undefined,
      newCorrelationId: () => 'c',
    });
    const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={query}>
        <WorkItemRecurrencePanel
          organizationSlug="northstar"
          workItemId="wi-1"
          api={client}
          today="2026-11-04"
        />
      </QueryClientProvider>,
    );

    const list = await screen.findByRole('list', { name: 'Next 5 dates' }, { timeout: 3000 });
    expect(list.querySelectorAll('li')).toHaveLength(5);
    expect(screen.getByText('Moved: holiday')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'This and future occurrences' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() =>
      expect(calls).toContain('POST /v1/organizations/northstar/work-items/wi-1/recurrence/pause'),
    );
  });
});
