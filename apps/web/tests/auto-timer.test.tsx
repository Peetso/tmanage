import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivitySignal } from '@tmanage/domain';
import { ApiClient } from '../src/lib/api/client';
import type { AutoTrackingState, TeamTime } from '../src/lib/api/time-auto';
import { activitySupport, startActivitySource } from '../src/lib/activity-sources';
import { autoTimerDisplay } from '../src/lib/auto-timer-state';
import { AutoTimerStatus } from '../src/components/time/AutoTimerStatus';
import { AutoTimePolicyCard } from '../src/components/screens/AutoTimePolicyCard';
import { FinanceTeamTimeScreen } from '../src/components/screens/finance/FinanceTeamTimeScreen';

/**
 * FIX-2026-11-10 — the automatic timer in the web app: what the chip says, where the computer's
 * activity comes from (desktop bridge, Idle Detection, or nothing — never the page), and the team
 * time screen that only holders of "View team time" see.
 */

const STATE: AutoTrackingState = {
  policy: 'optional',
  enabled: true,
  ownSwitch: true,
  idleThresholdMinutes: 5,
  maxIdleMinutes: 10,
  currentTask: null,
  session: null,
  manualTimerRunning: false,
  visibleTo: 'admins_and_authorized',
  serverNow: '2026-11-10T12:00:00.000Z',
};

interface Call {
  method: string;
  url: string;
  body?: string;
}

function client(routes: (call: Call) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const api = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = { method: init?.method ?? 'GET', url: String(input) };
      if (typeof init?.body === 'string') call.body = init.body;
      calls.push(call);
      const { status, body } = routes(call);
      return Promise.resolve(
        new Response(body === undefined ? null : JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
  return { api, calls };
}

function wrap(children: React.ReactNode) {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={query}>{children}</QueryClientProvider>);
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as { tmanageDesktop?: unknown }).tmanageDesktop;
});

describe('automatic timer display', () => {
  it('says what is happening, in order of what matters', () => {
    expect(autoTimerDisplay(undefined, 'desktop', true, 'active')).toBe('off');
    expect(autoTimerDisplay({ ...STATE, enabled: false }, 'desktop', true, 'active')).toBe('off');
    expect(
      autoTimerDisplay({ ...STATE, manualTimerRunning: true }, 'desktop', true, 'active'),
    ).toBe('manual');
    expect(autoTimerDisplay(STATE, 'unsupported', false, 'off')).toBe('unsupported');
    expect(autoTimerDisplay(STATE, 'idle-detector', false, 'off')).toBe('needs-permission');
    expect(autoTimerDisplay(STATE, 'desktop', true, 'active')).toBe('tracking');
    expect(autoTimerDisplay(STATE, 'desktop', true, 'idle')).toBe('paused-idle');
    expect(autoTimerDisplay(STATE, 'desktop', true, 'locked')).toBe('paused-locked');
    expect(autoTimerDisplay(STATE, 'desktop', true, 'asleep')).toBe('paused-asleep');
  });
});

describe('activity sources', () => {
  it('without the desktop app or Idle Detection there is no source and no page fallback', () => {
    expect(activitySupport()).toBe('unsupported');
    const emit = vi.fn();
    const stop = startActivitySource(emit);
    fireEvent.mouseMove(document.body);
    fireEvent.keyDown(document.body, { key: 'a' });
    stop();
    expect(emit).not.toHaveBeenCalled();
  });

  it('reads the desktop bridge: idle seconds and lock events, nothing else', async () => {
    let listener: ((event: 'locked' | 'unlocked' | 'suspended' | 'resumed') => void) | null = null;
    (window as unknown as { tmanageDesktop: unknown }).tmanageDesktop = {
      activity: {
        sample: () => Promise.resolve({ idleSeconds: 12, locked: false }),
        onEvent: (fn: typeof listener) => {
          listener = fn;
          return () => {
            listener = null;
          };
        },
      },
    };
    expect(activitySupport()).toBe('desktop');
    const signals: ActivitySignal[] = [];
    const stop = startActivitySource(
      (signal) => signals.push(signal),
      () => 1_000,
    );
    await waitFor(() =>
      expect(signals).toContainEqual({ type: 'sample', at: 1_000, idleSeconds: 12 }),
    );
    listener!('suspended');
    expect(signals.at(-1)).toEqual({ type: 'suspended', at: 1_000 });
    stop();
    expect(listener).toBeNull();
  });

  it('reads Idle Detection in Chrome / Edge: input samples and the screen lock', async () => {
    const now = 100_000;
    class FakeDetector extends EventTarget {
      userState: 'active' | 'idle' = 'active';
      screenState: 'locked' | 'unlocked' = 'unlocked';
      start() {
        return Promise.resolve();
      }
      static requestPermission() {
        return Promise.resolve('granted' as const);
      }
    }
    const made: FakeDetector[] = [];
    vi.stubGlobal(
      'IdleDetector',
      class extends FakeDetector {
        constructor() {
          super();
          made.push(this);
        }
      },
    );
    expect(activitySupport()).toBe('idle-detector');
    const signals: ActivitySignal[] = [];
    const stop = startActivitySource(
      (signal) => signals.push(signal),
      () => now,
    );
    await waitFor(() =>
      expect(signals).toContainEqual({ type: 'sample', at: now, idleSeconds: 0 }),
    );
    const detector = made[0]!;
    detector.userState = 'idle';
    detector.dispatchEvent(new Event('change'));
    detector.screenState = 'locked';
    detector.dispatchEvent(new Event('change'));
    expect(signals.at(-1)).toEqual({ type: 'locked', at: now });
    stop();
  });
});

describe('automatic timer chip', () => {
  it('in a browser that cannot see the computer: says so, with the privacy and visibility lines', async () => {
    const { api } = client((call) =>
      call.url.endsWith('/time/auto') ? { status: 200, body: STATE } : { status: 404 },
    );
    wrap(<AutoTimerStatus organizationSlug="northstar" client={api} />);
    const chip = await screen.findByRole('button', { name: /Auto timer/ });
    expect(chip).toHaveTextContent('Off, not available in this browser');
    fireEvent.click(chip);
    const panel = screen.getByRole('region', { name: 'Automatic timer' });
    expect(
      within(panel).getByText(/Use the TManage desktop app, or open TManage in Chrome or Edge/),
    ).toBeTruthy();
    expect(within(panel).getByText(/No screenshots, keystrokes, app or window names/)).toBeTruthy();
    expect(within(panel).getByText(/visible to your workspace owner and admins/)).toBeTruthy();
    expect(
      within(panel).getByRole('switch', { name: 'Track my time automatically' }),
    ).toBeChecked();
    // The idle choices stop at the owner's maximum (10 here).
    const idle = within(panel).getByRole('combobox', { name: /Pause after no activity for/ });
    const offered = within(idle)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(offered).toEqual(['1 min', '2 min', '3 min', '5 min', '10 min']);
  });

  it('is hidden when the owner turned automatic tracking off', async () => {
    const { api, calls } = client(() => ({ status: 200, body: { ...STATE, policy: 'off' } }));
    wrap(<AutoTimerStatus organizationSlug="northstar" client={api} />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: /Auto timer/ })).toBeNull();
  });
});

const TEAM: TeamTime = {
  from: '2026-11-09',
  to: '2026-11-15',
  today: '2026-11-10',
  week: { periodStart: '2026-11-09', periodEnd: '2026-11-15' },
  timeZone: 'Africa/Cairo',
  policy: 'optional',
  people: [
    {
      membershipId: 'm2',
      displayName: 'Basel',
      live: 'tracking',
      currentTask: { workItemId: 'w1', projectId: 'p1', title: 'Homepage copy' },
      todayMinutes: 45,
      weekMinutes: 300,
      rangeMinutes: 300,
      inProgressMinutes: 10,
      needsReview: true,
    },
    {
      membershipId: 'm3',
      displayName: 'Carim',
      live: 'paused',
      currentTask: { workItemId: null, projectId: null, title: null, private: true },
      todayMinutes: 0,
      weekMinutes: 0,
      rangeMinutes: 0,
      inProgressMinutes: 0,
      needsReview: false,
    },
  ],
  totals: { todayMinutes: 45, weekMinutes: 300, rangeMinutes: 300, inProgressMinutes: 10 },
  serverNow: '2026-11-10T12:00:00.000Z',
};

const me = (capabilities: string[]) => ({
  membershipId: 'm1',
  userId: 'u1',
  kind: 'internal',
  role: 'member',
  capabilities,
  overrides: { allow: [], deny: [] },
  supportSession: null,
});

describe('team time screen', () => {
  it('without "View team time": no tab, no request for the team, a plain line', async () => {
    const { api, calls } = client((call) =>
      call.url.endsWith('/me') ? { status: 200, body: me(['work.read']) } : { status: 404 },
    );
    wrap(<FinanceTeamTimeScreen organizationSlug="northstar" organizationName="N" client={api} />);
    expect(await screen.findByText('Not available to you')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Team time' })).toBeNull();
    expect(calls.some((call) => call.url.includes('/time/team'))).toBe(false);
  });

  it('with it: the tab, each person live state, task, today, week and totals, then a day', async () => {
    const { api, calls } = client((call) => {
      if (call.url.endsWith('/me'))
        return { status: 200, body: me(['work.read', 'time.view_team']) };
      if (call.url.includes('/time/team/m2/day'))
        return {
          status: 200,
          body: {
            membershipId: 'm2',
            displayName: 'Basel',
            day: '2026-11-10',
            timeZone: 'Africa/Cairo',
            totalMinutes: 45,
            inProgressMinutes: 10,
            sessions: [
              {
                id: null,
                startedAt: '2026-11-10T11:50:00.000Z',
                endedAt: null,
                minutes: 10,
                source: 'automatic',
                workItemId: 'w1',
                workItemTitle: 'Homepage copy',
                projectId: 'p1',
                private: false,
                needsReview: false,
                lateFrom: null,
                open: true,
              },
              {
                id: 'e1',
                startedAt: null,
                endedAt: null,
                minutes: 45,
                source: 'manual',
                workItemId: null,
                workItemTitle: null,
                projectId: null,
                private: false,
                needsReview: false,
                lateFrom: null,
                open: false,
              },
              {
                id: 'e2',
                startedAt: '2026-11-10T06:00:00.000Z',
                endedAt: '2026-11-10T06:30:00.000Z',
                minutes: 30,
                source: 'automatic',
                workItemId: null,
                workItemTitle: null,
                projectId: null,
                private: true,
                needsReview: true,
                lateFrom: '2026-11-03',
                open: false,
              },
            ],
          },
        };
      if (call.url.includes('/time/team')) return { status: 200, body: TEAM };
      if (call.url.endsWith('/projects')) return { status: 200, body: { projects: [] } };
      return { status: 404 };
    });
    wrap(<FinanceTeamTimeScreen organizationSlug="northstar" organizationName="N" client={api} />);
    const table = await screen.findByRole('table', { name: 'People' });
    const row = within(table).getByRole('row', { name: /Basel/ });
    expect(row).toHaveTextContent('Tracking');
    expect(row).toHaveTextContent('Homepage copy');
    expect(row).toHaveTextContent('45m');
    expect(row).toHaveTextContent('+ 10m in progress');
    expect(row).toHaveTextContent('Needs review');
    expect(row).toHaveTextContent('5h');
    // A task the viewer may not see is "Private task", never its title.
    expect(within(table).getByRole('row', { name: /Carim/ })).toHaveTextContent('Private task');
    expect(screen.getByText(/company time zone \(Africa\/Cairo\)/)).toBeTruthy();
    expect(screen.getByText(/reported by each person’s own computer, not verified/)).toBeTruthy();
    expect(await screen.findByRole('link', { name: 'Team time' })).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'Sessions' }));
    const sessions = await screen.findByRole('table', { name: 'Sessions' });
    expect(sessions).toHaveTextContent('Automatic');
    expect(sessions).toHaveTextContent('Still going');
    expect(sessions).toHaveTextContent('Manual');
    expect(sessions).toHaveTextContent('Unassigned work time');
    expect(sessions).toHaveTextContent('Automatic · reported by their computer');
    expect(sessions).toHaveTextContent('Private task');
    expect(sessions).toHaveTextContent('Late · tracked');
    expect(sessions).toHaveTextContent('Needs review');
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });
});

describe('automatic tracking policy card', () => {
  it('the owner sets the longest idle time people may choose, sent with the policy', async () => {
    const { api, calls } = client((call) =>
      call.method === 'PATCH'
        ? { status: 200, body: { policy: 'optional', maxIdleMinutes: 3 } }
        : { status: 200, body: STATE },
    );
    wrap(<AutoTimePolicyCard organizationSlug="northstar" client={api} isOwner />);
    const select = await screen.findByRole('combobox', {
      name: /Longest idle time people may choose/,
    });
    expect(select).toHaveValue('10');
    fireEvent.change(select, { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    const patch = calls.find((call) => call.method === 'PATCH');
    expect(JSON.parse(patch?.body ?? '{}')).toEqual({ policy: 'optional', maxIdleMinutes: 3 });
  });

  it('an admin reads it but cannot change it', async () => {
    const { api } = client(() => ({ status: 200, body: STATE }));
    wrap(<AutoTimePolicyCard organizationSlug="northstar" client={api} isOwner={false} />);
    const select = await screen.findByRole('combobox', {
      name: /Longest idle time people may choose/,
    });
    expect(select).toBeDisabled();
    expect(screen.getByText('Only the company owner can change this.')).toBeTruthy();
  });
});
