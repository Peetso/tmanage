import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import type { TimerState } from '../src/lib/api/time-timer';
import { RunningTimerPill } from '../src/components/time/TimerControls';
import { TimeRoundingCard } from '../src/components/screens/TimeRoundingCard';

/**
 * 52-01 (live check B9) — the Stop dialog announces the minutes that will really be saved: the
 * company's rounding step from the timer read, and it says the time is rounded. The owner's card
 * changes that step through `PATCH …/time/rounding`.
 */

const SLUG = 'northstar-studio';

function state(roundingMinutes: number, elapsedSeconds: number): TimerState {
  return {
    timer: {
      id: 't1',
      workItemId: null,
      projectId: null,
      note: null,
      billable: true,
      startedAt: '2026-11-10T09:00:00.000Z',
      lastHeartbeatAt: '2026-11-10T09:00:00.000Z',
      elapsedSeconds,
    },
    serverNow: '2026-11-10T09:00:11.000Z',
    roundingMinutes,
  };
}

function fakeApi(initial: TimerState) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  let current = initial;
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: string, init?: RequestInit) => {
      const url = new URL(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, path: url.pathname, body });
      if (url.pathname.endsWith('/time/rounding') && method === 'PATCH') {
        current = {
          ...current,
          roundingMinutes: (body as { roundingMinutes: number }).roundingMinutes,
        };
      }
      const answer = url.pathname.endsWith('/time/rounding')
        ? { roundingMinutes: current.roundingMinutes }
        : current;
      return Promise.resolve(
        new Response(JSON.stringify(answer), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
  return { client, calls };
}

function renderWithQuery(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

async function openStopDialog(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
  return screen.findByRole('dialog', { name: 'Stop timer' });
}

describe('52-01 Stop dialog rounding', () => {
  it('shows the rounded amount that will be saved and says it is rounded', async () => {
    const { client } = fakeApi(state(15, 11));
    renderWithQuery(<RunningTimerPill organizationSlug={SLUG} client={client} />);
    const dialog = await openStopDialog();
    expect(within(dialog).getByText('15 min (rounded up to the nearest 15 minutes)')).toBeTruthy();
  });

  it('uses the configured step', async () => {
    const { client } = fakeApi(state(5, 6 * 60 + 11));
    renderWithQuery(<RunningTimerPill organizationSlug={SLUG} client={client} />);
    const dialog = await openStopDialog();
    expect(within(dialog).getByText('10 min (rounded up to the nearest 5 minutes)')).toBeTruthy();
  });

  it('UX T-P1-1: 13 seconds shows the real time, leads with Discard, and discards after a confirm', async () => {
    const { client, calls } = fakeApi(state(15, 13));
    renderWithQuery(<RunningTimerPill organizationSlug={SLUG} client={client} />);
    const dialog = await openStopDialog();
    expect(within(dialog).getByText('Timed: 00:00:13')).toBeTruthy();
    expect(within(dialog).getByText(/less than a minute/u)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard' }));
    // UX test item 7: focus moves into the confirmation that replaced the buttons.
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Keep it' }));
    expect(calls.some((c) => c.path.endsWith('/timer/discard'))).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard timer' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/timer/discard'))).toBe(
        true,
      ),
    );
    expect(calls.some((c) => c.path.endsWith('/timer/stop'))).toBe(false);
  });

  it('UX T-P1-1: the person may save less than the rounded amount, never more', async () => {
    const { client, calls } = fakeApi(state(15, 13));
    renderWithQuery(<RunningTimerPill organizationSlug={SLUG} client={client} />);
    const dialog = await openStopDialog();
    const minutes = within(dialog).getByLabelText(/Minutes to save/u);
    fireEvent.change(minutes, { target: { value: '16' } });
    expect(within(dialog).getByRole('button', { name: 'Save time' })).toBeDisabled();
    fireEvent.change(minutes, { target: { value: '1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save time' }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/timer/stop'))).toBe(true));
    expect(calls.find((c) => c.path.endsWith('/timer/stop'))?.body).toMatchObject({ minutes: 1 });
  });

  it('shows exact minutes with no rounding note when the owner chose no rounding', async () => {
    const { client } = fakeApi(state(1, 11));
    renderWithQuery(<RunningTimerPill organizationSlug={SLUG} client={client} />);
    const dialog = await openStopDialog();
    expect(within(dialog).getByText('1 min')).toBeTruthy();
    expect(within(dialog).queryByText(/rounded/u)).toBeNull();
  });
});

describe('52-01 timer rounding card', () => {
  it('lets the owner choose a step and saves it through the owner route', async () => {
    const { client, calls } = fakeApi(state(15, 11));
    renderWithQuery(<TimeRoundingCard organizationSlug={SLUG} client={client} isOwner />);
    const select = await screen.findByLabelText('Round timer time up to');
    expect((select as HTMLSelectElement).value).toBe('15');
    fireEvent.change(select, { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'PATCH',
        path: `/v1/organizations/${SLUG}/time/rounding`,
        body: { roundingMinutes: 1 },
      }),
    );
    expect(await screen.findByText('Saved.')).toBeTruthy();
  });

  it('is read-only for anyone but the owner', async () => {
    const { client } = fakeApi(state(15, 11));
    renderWithQuery(<TimeRoundingCard organizationSlug={SLUG} client={client} isOwner={false} />);
    const select = await screen.findByLabelText('Round timer time up to');
    expect((select as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByText('Only the company owner can change this.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });
});
