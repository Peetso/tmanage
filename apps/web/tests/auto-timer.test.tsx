import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseTrackingDeviceReport, type ActivitySignal } from '@tmanage/domain';
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
    expect(autoTimerDisplay(undefined, 'desktop', 'granted', 'active')).toBe('off');
    expect(autoTimerDisplay({ ...STATE, enabled: false }, 'desktop', 'granted', 'active')).toBe(
      'off',
    );
    // Item 1: the owner switched it off for everyone; item 12: the browser blocked it.
    expect(autoTimerDisplay({ ...STATE, policy: 'off' }, 'desktop', 'granted', 'active')).toBe(
      'policy-off',
    );
    expect(autoTimerDisplay(STATE, 'idle-detector', 'denied', 'off')).toBe('blocked');
    expect(
      autoTimerDisplay({ ...STATE, manualTimerRunning: true }, 'desktop', 'granted', 'active'),
    ).toBe('manual');
    expect(autoTimerDisplay(STATE, 'unsupported', 'prompt', 'off')).toBe('unsupported');
    expect(autoTimerDisplay(STATE, 'idle-detector', 'prompt', 'off')).toBe('needs-permission');
    expect(autoTimerDisplay(STATE, 'desktop', 'granted', 'active')).toBe('tracking');
    expect(autoTimerDisplay(STATE, 'desktop', 'granted', 'idle')).toBe('paused-idle');
    expect(autoTimerDisplay(STATE, 'desktop', 'granted', 'locked')).toBe('paused-locked');
    expect(autoTimerDisplay(STATE, 'desktop', 'granted', 'asleep')).toBe('paused-asleep');
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
    // Item 6: a short label on the chip; the full sentence is in the hover help.
    expect(chip).toHaveTextContent('Not available');
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
    // Item 14: no personal pause choice; one line with the workspace's threshold.
    expect(within(panel).queryByRole('combobox')).toBeNull();
    expect(within(panel).getByText(/pauses by itself after 5 minutes/)).toBeTruthy();
  });

  it('item 13: "On for everyone" has no personal switch', async () => {
    const { api } = client((call) =>
      call.url.endsWith('/time/auto')
        ? { status: 200, body: { ...STATE, policy: 'required' } }
        : { status: 200, body: {} },
    );
    wrap(<AutoTimerStatus organizationSlug="northstar" client={api} />);
    fireEvent.click(await screen.findByRole('button', { name: /Auto timer/ }));
    const panel = screen.getByRole('region', { name: 'Automatic timer' });
    expect(within(panel).queryByRole('switch')).toBeNull();
    expect(within(panel).getByText(/turned this on for everyone/)).toBeTruthy();
  });

  it('item 12: a blocked permission is detected and the panel says what to click', async () => {
    const status = Object.assign(new EventTarget(), { state: 'denied' });
    vi.stubGlobal('navigator', {
      ...navigator,
      permissions: { query: () => Promise.resolve(status) },
    });
    (window as unknown as { IdleDetector?: unknown }).IdleDetector = class {};
    const { api } = client((call) =>
      call.url.endsWith('/time/auto') ? { status: 200, body: STATE } : { status: 200, body: {} },
    );
    wrap(<AutoTimerStatus organizationSlug="northstar" client={api} />);
    const chip = await screen.findByRole('button', { name: /Auto timer/ });
    await waitFor(() => expect(chip).toHaveTextContent('Blocked'));
    fireEvent.click(chip);
    expect(screen.getByText(/set "Idle detection" to Allow, then reload/)).toBeTruthy();
    delete (window as unknown as { IdleDetector?: unknown }).IdleDetector;
  });

  it('UX T-P2-5: while a manual timer runs, the header shows one state (the pill), no chip', async () => {
    const { api, calls } = client((call) => {
      if (call.url.endsWith('/time/auto')) return { status: 200, body: STATE };
      if (call.url.endsWith('/time/timer')) {
        return {
          status: 200,
          body: {
            timer: {
              id: 't1',
              workItemId: null,
              projectId: null,
              note: null,
              billable: true,
              startedAt: '2026-11-10T09:00:00.000Z',
              lastHeartbeatAt: '2026-11-10T09:00:00.000Z',
              elapsedSeconds: 30,
            },
            serverNow: '2026-11-10T09:00:30.000Z',
            roundingMinutes: 1,
          },
        };
      }
      return { status: 200, body: {} };
    });
    wrap(<AutoTimerStatus organizationSlug="northstar" client={api} />);
    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/time/timer'))).toBe(true));
    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/time/auto'))).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('button', { name: /Auto timer/ })).toBeNull();
  });

  it('UX item 7: the chip has a full name and Escape returns focus to it', async () => {
    const { api } = client((call) =>
      call.url.endsWith('/time/auto') ? { status: 200, body: STATE } : { status: 200, body: {} },
    );
    wrap(<AutoTimerStatus organizationSlug="northstar" client={api} />);
    const chip = await screen.findByRole('button', { name: /^Auto timer: / });
    fireEvent.click(chip);
    expect(document.activeElement?.getAttribute('role')).toBe('group');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Auto timer: / }));
  });

  it('UX bug 2: never opens by itself away from the home page (over a form)', async () => {
    window.localStorage.clear();
    window.history.replaceState(null, '', '/northstar/projects/p1/deliverables/new');
    const { api } = client((call) =>
      call.url.endsWith('/time/auto')
        ? { status: 200, body: { ...STATE, enabled: false, ownSwitch: false } }
        : { status: 200, body: {} },
    );
    wrap(<AutoTimerStatus organizationSlug="northstar" client={api} />);
    await screen.findByRole('button', { name: /Auto timer/ });
    expect(screen.queryByRole('button', { name: 'Turn on automatic time tracking' })).toBeNull();
    window.history.replaceState(null, '', '/');
  });

  it('item 15: asks once, as one button, and never opens by itself again', async () => {
    window.localStorage.clear();
    // UX bug 2: the ask opens by itself on the home page only.
    window.history.replaceState(null, '', '/northstar/home');
    const { api } = client((call) =>
      call.url.endsWith('/time/auto')
        ? { status: 200, body: { ...STATE, enabled: false, ownSwitch: false } }
        : { status: 200, body: {} },
    );
    const first = wrap(<AutoTimerStatus organizationSlug="northstar" client={api} />);
    expect(
      await screen.findByRole('button', { name: 'Turn on automatic time tracking' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Allow activity detection/ })).toBeNull();
    first.unmount();
    wrap(<AutoTimerStatus organizationSlug="northstar" client={api} />);
    await screen.findByRole('button', { name: /Auto timer/ });
    expect(screen.queryByRole('region', { name: 'Automatic timer' })).toBeNull();
    window.history.replaceState(null, '', '/');
  });

  it('item 17: reports where tracking runs, so the owner can see it', async () => {
    const { api, calls } = client((call) =>
      call.url.endsWith('/time/auto') ? { status: 200, body: STATE } : { status: 200, body: {} },
    );
    wrap(<AutoTimerStatus organizationSlug="northstar" client={api} />);
    await waitFor(() =>
      expect(calls.some((call) => call.method === 'PUT' && call.url.endsWith('/auto/device'))).toBe(
        true,
      ),
    );
    const put = calls.find((call) => call.url.endsWith('/auto/device'));
    // Checked against the shared schema the API parses with, not a hand-written shape.
    expect(parseTrackingDeviceReport(JSON.parse(put?.body ?? '{}'))).toEqual({
      device: 'browser_unsupported',
    });
  });

  it('item 1: hidden for a company that never used it; "Off" with the reason once it did', async () => {
    window.localStorage.clear();
    const { api, calls } = client(() => ({ status: 200, body: { ...STATE, policy: 'off' } }));
    const never = wrap(<AutoTimerStatus organizationSlug="northstar" client={api} />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: /Auto timer/ })).toBeNull();
    never.unmount();
    window.localStorage.setItem('tm.autotimer.used.northstar', '1');
    wrap(<AutoTimerStatus organizationSlug="northstar" client={api} />);
    const chip = await screen.findByRole('button', { name: /Auto timer/ });
    expect(chip).toHaveTextContent('Off');
    fireEvent.click(chip);
    expect(screen.getByText(/switched automatic tracking off/)).toBeTruthy();
    expect(screen.getByText(/saved up to your last activity/)).toBeTruthy();
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
      device: { kind: 'desktop', seenAt: '2026-11-10T11:59:00.000Z' },
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
      device: null,
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
    // Item 11: the zone by a readable name; item 17: where each person's tracking runs.
    expect(screen.getByText(/company time zone \(Cairo\)/)).toBeTruthy();
    // UX test T-P2-3: the detail sits behind "How is this counted?".
    expect(screen.getByText('How is this counted?').tagName).toBe('SUMMARY');
    expect(screen.getByText(/each person’s own computer activity/)).toBeTruthy();
    expect(screen.getByText(/also see where each person’s tracking runs/)).toBeTruthy();
    expect(row).toHaveTextContent('Desktop app');
    expect(within(table).getByRole('row', { name: /Carim/ })).toHaveTextContent('No device seen');
    expect(await screen.findByRole('link', { name: 'Team time' })).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'Sessions' }));
    const sessions = await screen.findByRole('table', { name: 'Sessions' });
    expect(sessions).toHaveTextContent('Automatic');
    expect(sessions).toHaveTextContent('Still going');
    expect(sessions).toHaveTextContent('Manual');
    expect(sessions).toHaveTextContent('Unassigned time');
    // Item 11: clock times in the company zone (11:50 UTC is 1:50 PM in Cairo), named.
    expect(sessions).toHaveTextContent('1:50');
    expect(screen.getByText(/Clock times in Cairo time/)).toBeTruthy();
    expect(sessions).toHaveTextContent('Automatic · reported by their computer');
    expect(sessions).toHaveTextContent('Private task');
    expect(sessions).toHaveTextContent('Late · tracked');
    expect(sessions).toHaveTextContent('Needs review');
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });
});

describe('automatic tracking policy card', () => {
  it('the owner sets when someone counts as away (1 to 15 minutes), sent with the policy', async () => {
    const { api, calls } = client((call) =>
      call.method === 'PATCH'
        ? { status: 200, body: { policy: 'optional', maxIdleMinutes: 3 } }
        : { status: 200, body: STATE },
    );
    wrap(<AutoTimePolicyCard organizationSlug="northstar" client={api} isOwner />);
    const select = await screen.findByRole('combobox', { name: /Count someone as away after/ });
    expect(select).toHaveValue('10');
    expect(within(select).getAllByRole('option')).toHaveLength(15);
    // Item 18: the note under "On for everyone".
    expect(screen.getByText(/people use the TManage desktop app/)).toBeTruthy();
    fireEvent.change(select, { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    const patch = calls.find((call) => call.method === 'PATCH');
    expect(JSON.parse(patch?.body ?? '{}')).toEqual({ policy: 'optional', maxIdleMinutes: 3 });
  });

  it('an admin reads it but cannot change it', async () => {
    const { api } = client(() => ({ status: 200, body: STATE }));
    wrap(<AutoTimePolicyCard organizationSlug="northstar" client={api} isOwner={false} />);
    const select = await screen.findByRole('combobox', { name: /Count someone as away after/ });
    expect(select).toBeDisabled();
    expect(screen.getByText('Only the company owner can change this.')).toBeTruthy();
  });
});
