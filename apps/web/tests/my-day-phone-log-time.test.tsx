import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogTimeSheet } from '../src/components/screens/MyDayPhoneSheets';
import { ApiClient } from '../src/lib/api/client';
import type { TimeTrustPolicy } from '../src/lib/api/time-trust';

/** PHONE (55-20): log time from My Day in three taps — Log time, a minutes chip, Log time. */
afterEach(cleanup);

/**
 * Time trust (2026-11-23): hand time obeys the owner's policy (off by default) and needs a reason.
 * The fake API answers the policy read and records every write.
 */
function renderSheet(handTimeAllowed: boolean) {
  const writes: { path: string; body: unknown }[] = [];
  const policy: TimeTrustPolicy = {
    handTimeAllowed,
    handTimeCountMode: 'after_approval',
    idleCapHours: 10,
    mayChange: false,
  };
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/time/trust-policy')) {
        return Promise.resolve(
          new Response(JSON.stringify(policy), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      writes.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
      return Promise.resolve(
        new Response(JSON.stringify({ id: 't1', minutes: 30, spentOn: '2026-11-18', note: null }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
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
  return { writes, onLogged };
}

describe('My Day phone · Log time sheet', () => {
  it('a chip fills the minutes, the day defaults to today, and the entry posts', async () => {
    const { writes, onLogged } = renderSheet(true);

    screen.getByRole('dialog', { name: 'Log time' });
    const chip = await screen.findByRole('button', { name: '30' });
    expect((screen.getByLabelText('Day', { exact: false }) as HTMLInputElement).value).toBe(
      '2026-11-18',
    );
    const submit = screen.getByRole('button', { name: 'Log time' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.click(chip);
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('30');
    // Hand time needs a reason before it can be sent.
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Why are you adding this by hand?', { exact: false }), {
      target: { value: 'Timer was not running' },
    });
    expect(submit.disabled).toBe(false);

    fireEvent.click(submit);
    await waitFor(() => expect(onLogged).toHaveBeenCalledWith('saved'));
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toMatch(/\/organizations\/acme\/work-items\/w1\/time-logs$/);
    expect(writes[0]?.body).toEqual({
      minutes: 30,
      spentOn: '2026-11-18',
      note: null,
      reason: 'Timer was not running',
    });
  });

  it('with hand time off, offers no chips and says the owner records time with the timer', async () => {
    const { writes } = renderSheet(false);

    await screen.findByText('Time comes from the timer');
    expect(screen.queryByRole('button', { name: '30' })).toBeNull();
    const submit = screen.getByRole('button', { name: 'Log time' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(writes).toHaveLength(0);
  });
});
