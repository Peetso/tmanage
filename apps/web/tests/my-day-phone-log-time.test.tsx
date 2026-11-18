import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogTimeSheet } from '../src/components/screens/MyDayPhoneSheets';
import { ApiClient } from '../src/lib/api/client';

/** PHONE (55-20): log time from My Day in three taps — Log time, a minutes chip, Log time. */
afterEach(cleanup);

describe('My Day phone · Log time sheet', () => {
  it('a chip fills the minutes, the day defaults to today, and the entry posts', async () => {
    const calls: { path: string; body: unknown }[] = [];
    const client = new ApiClient({
      baseUrl: 'https://api.example.test',
      csrfCookieName: 'tm_session_csrf',
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          path: new URL(String(input)).pathname,
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return Promise.resolve(
          new Response(
            JSON.stringify({ id: 't1', minutes: 30, spentOn: '2026-11-18', note: null }),
            { status: 201, headers: { 'content-type': 'application/json' } },
          ),
        );
      }) as typeof globalThis.fetch,
      readCsrfToken: () => 'csrf',
      newCorrelationId: () => 'c',
    });
    const onLogged = vi.fn();
    const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={query}>
        <LogTimeSheet
          api={client}
          organizationSlug="acme"
          workItemId="w1"
          workTitle="Prepare mobile booking flow"
          projectName="Atlas"
          onClose={() => undefined}
          onLogged={onLogged}
          today={new Date(2026, 10, 18, 9, 0)}
        />
      </QueryClientProvider>,
    );

    screen.getByRole('dialog', { name: 'Log time' });
    expect((screen.getByLabelText('Day', { exact: false }) as HTMLInputElement).value).toBe(
      '2026-11-18',
    );
    const submit = screen.getByRole('button', { name: 'Log time' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    const chip = screen.getByRole('button', { name: '30' });
    fireEvent.click(chip);
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('30');
    expect(submit.disabled).toBe(false);

    fireEvent.click(submit);
    await waitFor(() => expect(onLogged).toHaveBeenCalledWith('saved'));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toMatch(/\/organizations\/acme\/work-items\/w1\/time-logs$/);
    expect(calls[0]?.body).toEqual({ minutes: 30, spentOn: '2026-11-18', note: null });
  });
});
