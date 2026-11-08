import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { WorkingCalendarScreen, packLabel } from '../src/components/screens/WorkingCalendarScreen';
import { ApiClient } from '../src/lib/api/client';
import { toggleWeekday } from '../src/lib/api/working-calendar';

/**
 * 53-02 working calendar screen (Figma 590:33665). Validation, the `org.manage` gate and the pack
 * import are the API's (`working-calendar.test.ts`); this file proves the requests the screen sends.
 */

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

const CALENDAR = {
  scope: 'org',
  projectId: null,
  isDefault: false,
  inherited: false,
  workingDays: [0, 1, 2, 3, 4],
  dayStart: '09:00',
  dayEnd: '17:00',
  timeZone: 'Asia/Riyadh',
  version: 3,
  holidays: [
    {
      id: 'h1',
      date: '2027-02-22',
      labelEn: 'Founding Day',
      labelAr: 'يوم التأسيس',
      source: 'pack',
      packKey: 'ksa-2027',
      packVersion: '1',
      estimated: false,
    },
  ],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function harness() {
  const calls: Call[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith('/working-calendar')) return Promise.resolve(json(CALENDAR));
      if (url.endsWith('/working-calendar/import-pack')) return Promise.resolve(json(CALENDAR));
      if (url.endsWith('/working-calendar/holidays'))
        return Promise.resolve(json(CALENDAR.holidays[0], 201));
      if (url.includes('/working-calendar/holidays/'))
        return Promise.resolve(new Response(null, { status: 204 }));
      return Promise.resolve(json({}, 404));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf',
    newCorrelationId: () => 'corr',
  });
  return { client, calls };
}

function withQuery(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function sent(calls: readonly Call[], method: string, suffix: string): Call | undefined {
  return calls.find((c) => c.method === method && c.url.endsWith(suffix));
}

describe('working calendar helpers (53-02)', () => {
  it('toggles a weekday and keeps the list Sunday-first', () => {
    expect(toggleWeekday([0, 1, 2], 5)).toEqual([0, 1, 2, 5]);
    expect(toggleWeekday([0, 1, 2], 1)).toEqual([0, 2]);
  });

  it('names a shipped pack by country and year', () => {
    expect(packLabel('ksa-2027')).toBe('Saudi Arabia 2027');
    expect(packLabel('nope')).toBe('nope');
  });
});

describe('WorkingCalendarScreen (53-02)', () => {
  it('saves the working week with the version it read', async () => {
    const { client, calls } = harness();
    render(
      withQuery(
        <WorkingCalendarScreen organizationSlug="acme" organizationName="Acme" client={client} />,
      ),
    );

    fireEvent.click(await screen.findByLabelText('Friday'));
    fireEvent.click(screen.getByRole('button', { name: 'Save calendar' }));
    await waitFor(() => expect(sent(calls, 'PUT', '/working-calendar')).toBeDefined());
    expect(sent(calls, 'PUT', '/working-calendar')?.body).toEqual({
      workingDays: [0, 1, 2, 3, 4, 5],
      dayStart: '09:00',
      dayEnd: '17:00',
      timeZone: 'Asia/Riyadh',
      version: 3,
    });
  });

  it('imports a country pack, adds a holiday and removes one', async () => {
    const { client, calls } = harness();
    render(
      withQuery(
        <WorkingCalendarScreen organizationSlug="acme" organizationName="Acme" client={client} />,
      ),
    );

    expect(await screen.findByText('Founding Day')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Add a country's public holidays"), {
      target: { value: 'uae-2027' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add holidays' }));
    await waitFor(() =>
      expect(sent(calls, 'POST', '/import-pack')?.body).toEqual({ packKey: 'uae-2027' }),
    );

    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2027-01-01' } });
    fireEvent.change(screen.getByLabelText('Name in English'), {
      target: { value: "New Year's Day" },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add holiday' }));
    await waitFor(() =>
      expect(sent(calls, 'POST', '/holidays')?.body).toEqual({
        date: '2027-01-01',
        labelEn: "New Year's Day",
        labelAr: null,
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove holiday: Founding Day' }));
    await waitFor(() => expect(sent(calls, 'DELETE', '/holidays/h1')).toBeDefined());
  });
});
