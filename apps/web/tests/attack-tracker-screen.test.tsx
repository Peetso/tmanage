import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AttackTrackerScreen } from '../src/components/platform/security/AttackTrackerScreen';
import { ApiClient } from '../src/lib/api/client';
import type { NetworkAccessView, TrackPage } from '../src/lib/api/platform-security';
import {
  DOOR,
  PLATFORM_ME,
  TRACKER_NOW,
  TRACKS,
  trackDetail,
} from '../stories/support/attack-tracker-fixtures';

/** SEC-TRACKER — Platform admin › Security › Attack tracker (Figma 833:85442). */

interface Call {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
}

const PAGE: TrackPage = {
  tracks: TRACKS,
  from: '2026-11-15T12:00:00.000Z',
  total: 8,
  counts: { all: 8, critical: 1, high: 2, vpn: 2, tor: 1, hosting: 3, known_tester: 1 },
  nextCursor: null,
  truncated: false,
};

function setup(options: { door?: NetworkAccessView; page?: TrackPage } = {}) {
  const calls: Call[] = [];
  const api = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    readCsrfToken: () => 'csrf',
    newCorrelationId: () => 'c',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      calls.push({
        method,
        path: url.pathname,
        query: url.searchParams,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      });
      const reply = (status: number, body?: unknown) =>
        Promise.resolve(
          new Response(body === undefined ? null : JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          }),
        );
      if (method !== 'GET') return reply(204);
      if (url.pathname === '/v1/platform/me') return reply(200, PLATFORM_ME);
      if (url.pathname === '/v1/platform/security/attack-tracks')
        return reply(200, options.page ?? PAGE);
      if (url.pathname.startsWith('/v1/platform/security/attack-tracks/')) {
        const found = TRACKS.find((track) => url.pathname.endsWith(track.trackId));
        return found ? reply(200, trackDetail(found)) : reply(404, {});
      }
      if (url.pathname === '/v1/platform/security/network-access')
        return reply(200, options.door ?? DOOR);
      return reply(404, {});
    }) as typeof globalThis.fetch,
  });
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queries}>
      <AttackTrackerScreen client={api} now={() => TRACKER_NOW} />
    </QueryClientProvider>,
  );
  return { calls, writes: () => calls.filter((call) => call.method !== 'GET') };
}

const detailHeading = () => screen.findByRole('heading', { level: 2, name: '89.187.162.18' });

describe('Attack tracker (SEC-TRACKER)', () => {
  it('shows the week: the four totals, the worst source open and the nav item current (840:1578)', async () => {
    const { calls } = setup();
    await detailHeading();
    const tiles = document.querySelector('.tm-at-tiles') as HTMLElement;
    expect(within(tiles).getByText('8')).toBeTruthy();
    expect(within(tiles).getByText('333')).toBeTruthy();
    expect(within(tiles).getByText('57')).toBeTruthy();
    expect(screen.getByText('Last 7 days')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Attack tracker' }).getAttribute('aria-current')).toBe(
      'page',
    );
    // The detail: facts, the folded timeline and the actions.
    expect(await screen.findByText('Password sign-in ×38')).toBeTruthy();
    expect(screen.getByText('AS60068')).toBeTruthy();
    expect(screen.getByText('12 accounts · Wrong password')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'All 63 attempts' })).toBeTruthy();
    // The list reads the 7-day window and asks for no filter.
    const list = calls.find((call) => call.path === '/v1/platform/security/attack-tracks');
    expect(list?.query.get('from')).toBeTruthy();
    expect(list?.query.has('filter')).toBe(false);
  });

  it('greys "Add to allowlist" on an allowlisted source and refuses it on a blocked one (build rule 1)', async () => {
    const { writes } = setup();
    await detailHeading();
    fireEvent.click(screen.getByRole('button', { name: 'Actions for 48.47.63.166' }));
    const onList = screen.getByRole('menuitem', { name: 'On the allowlist' });
    expect(onList.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(onList);
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Actions for 185.220.101.47' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add to allowlist' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('This address is blocked. Unblock it first.')).toBeTruthy();
    expect(writes()).toEqual([]);
  });

  it('refuses to block an allowlisted address and names the entry that holds it', async () => {
    const { writes } = setup();
    await detailHeading();
    fireEvent.click(screen.getByRole('button', { name: 'Actions for 48.47.63.166' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Block source' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(
        'This address is inside an allowlist entry: 48.47.63.166/32. Remove that entry first.',
      ),
    ).toBeTruthy();
    expect(writes()).toEqual([]);
  });

  it('blocks the worst source with its note and says so', async () => {
    const { writes } = setup();
    await detailHeading();
    fireEvent.click(screen.getByRole('button', { name: 'Block source' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Note (optional)'), {
      target: { value: 'Stolen-password attempts' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Block source' }));
    await waitFor(() =>
      expect(writes()).toEqual([
        expect.objectContaining({
          method: 'POST',
          path: '/v1/platform/security/network-access/blocklist',
          body: { value: '89.187.162.18', note: 'Stolen-password attempts' },
        }),
      ]),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('Address blocked.')).toBeTruthy();
  });

  it('turns the sign-in door off only after asking, and on at once', async () => {
    const { writes } = setup();
    const door = await screen.findByRole('switch', {
      name: 'Refuse VPN, proxy, Tor and data-centre addresses',
    });
    expect((door as HTMLInputElement).checked).toBe(true);
    fireEvent.click(door);
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByRole('heading', { name: 'Turn the sign-in door off?' }),
    ).toBeTruthy();
    expect(writes()).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('turns a door that is off back on without a dialog', async () => {
    const { writes } = setup({ door: { ...DOOR, policy: 'allow' } });
    const door = await screen.findByRole('switch', {
      name: 'Refuse VPN, proxy, Tor and data-centre addresses',
    });
    fireEvent.click(door);
    await waitFor(() =>
      expect(writes()).toEqual([
        expect.objectContaining({
          method: 'PUT',
          path: '/v1/platform/security/network-access/policy',
          body: { mode: 'refuse' },
        }),
      ]),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('signs the account that got in out everywhere, with a reason (people sign-out route)', async () => {
    const { writes } = setup();
    await detailHeading();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Sign this account out everywhere' }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByRole('heading', { name: 'Sign Mona Adel out everywhere?' }),
    ).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(/^Reason/), {
      target: { value: 'Got in after 38 stolen-password attempts' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }));
    await waitFor(() =>
      expect(writes()).toEqual([
        expect.objectContaining({
          method: 'POST',
          path: '/v1/platform/people/user-1/sign-out',
        }),
      ]),
    );
  });

  it('shows the quiet week when nothing happened', async () => {
    setup({
      page: {
        ...PAGE,
        tracks: [],
        total: 0,
        counts: { all: 0, critical: 0, high: 0, vpn: 0, tor: 0, hosting: 0, known_tester: 0 },
      },
    });
    expect(await screen.findByText('No attacks in the last 7 days')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Known tester' })).toBeNull();
  });
});
