import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { AiSpendScreen } from '../src/components/platform/ai-spend/AiSpendScreen';
import type { AiBudgetView, AiTestListView } from '../src/lib/api/ai-spend';
import type { PlatformMeView } from '../src/lib/api/platform-admin';

/** Plan 62-19 — Platform admin › AI spend (Figma G13 v2 784:48078, 784:49225, 785:48413–49122). */

const M = 1_000_000; // micro-USD per dollar
const NOW = new Date('2026-12-10T12:00:00Z');

function me(overrides: Partial<PlatformMeView> = {}): PlatformMeView {
  return {
    email: 'admin@example.test',
    displayName: 'Admin',
    mfaEnabled: true,
    stepUpNeedsAuthenticatorCode: true,
    // Confirmed 12 minutes ago in a 24-hour window: fresh for the reserve.
    stepUpExpiresAt: new Date(NOW.getTime() + (24 * 60 - 12) * 60_000).toISOString(),
    stepUpMinutes: 24 * 60,
    source: 'env',
    preset: 'super_admin',
    permissions: ['platform.settings.edit'],
    supportSessions: [],
    ...overrides,
  };
}

const BUDGET: AiBudgetView = {
  ceilingMicroUsd: 1500 * M,
  capsMicroUsd: { customers: 700 * M, testing: 300 * M, reserve: 500 * M },
  sonnetEnabled: true,
  paused: false,
  periodStart: '2026-12-01T00:00:00Z',
  pools: [
    pool('customers', 700, 268, 12, false),
    { ...pool('testing', 300, 83, 6, true), pausedReason: 'cap_lowered' },
    pool('reserve', 500, 61, 20, false),
  ],
  updatedAt: null,
  updatedBy: null,
};

function pool(
  name: 'customers' | 'testing' | 'reserve',
  cap: number,
  spent: number,
  held: number,
  paused: boolean,
) {
  return {
    pool: name,
    capMicroUsd: cap * M,
    settledMicroUsd: spent * M,
    reservedMicroUsd: held * M,
    remainingMicroUsd: (cap - spent - held) * M,
    paused,
    pausedReason: null,
  };
}

const LIST: AiTestListView = {
  workspaces: [
    {
      organizationId: 'org-1',
      name: 'Northstar Studio',
      slug: 'northstar',
      listedAt: null,
      poolClass: 'customers',
    },
    {
      organizationId: 'org-2',
      name: 'Cedar Agency',
      slug: 'cedar',
      listedAt: null,
      poolClass: 'testing',
    },
  ],
  openRequests: [{ id: 'req-1', organizationId: 'org-2', requestedAt: '2026-12-08T09:00:00Z' }],
  maxPackCredits: 10000,
};

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly headers: Headers;
}

type Route = { status: number; body: unknown };

function setup(
  options: { me?: PlatformMeView; routes?: Record<string, Route | ((call: Call) => Route)> } = {},
) {
  const calls: Call[] = [];
  const routes: Record<string, Route | ((call: Call) => Route)> = {
    'GET /v1/platform/me': { status: 200, body: options.me ?? me() },
    'GET /v1/platform/settings/ai-budget': { status: 200, body: BUDGET },
    'GET /v1/platform/ai/test-list': { status: 200, body: LIST },
    ...options.routes,
  };
  const api = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const path = new URL(String(input)).pathname;
      const call: Call = {
        method,
        path,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
        headers: new Headers(init?.headers),
      };
      calls.push(call);
      const found = routes[`${method} ${path}`];
      const answer = typeof found === 'function' ? found(call) : found;
      const reply = answer ?? { status: 404, body: { error: { code: 'not_found', message: 'x' } } };
      return Promise.resolve(
        new Response(JSON.stringify(reply.body), {
          status: reply.status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf',
    newCorrelationId: () => 'c',
  });
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queries}>
      <AiSpendScreen client={api} now={() => NOW} />
    </QueryClientProvider>,
  );
  return { calls, writes: () => calls.filter((call) => call.method !== 'GET') };
}

const REASON = 'Moving spend for the launch week';

describe('AI spend (62-19)', () => {
  it('shows the month, the pools and the pool still paused by its cap (784:49225)', async () => {
    setup();
    expect(await screen.findByText('$412')).toBeTruthy();
    expect(screen.getByText('of the $1,500 ceiling · 27 %')).toBeTruthy();
    expect(screen.getByText('$38')).toBeTruthy();
    expect(screen.getByText('Spent $268 · held $12 · $420 left of $700 cap')).toBeTruthy();
    expect(screen.getByText('Paused: over its cap')).toBeTruthy();
    expect(
      screen.getByText(
        'AI is on again. Testing stays paused because it is over its cap. Raise its cap to resume it.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'AI spend' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(await screen.findAllByText('Cedar Agency')).toHaveLength(2);
  });

  it('refuses a cap above the ceiling and saves a valid one with all three caps (785:48413, 785:48502)', async () => {
    const { writes } = setup({
      routes: { 'PUT /v1/platform/settings/ai-budget': { status: 200, body: BUDGET } },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Change the Testing cap' }));
    const dialog = screen.getByRole('dialog');
    const amount = within(dialog).getByRole('textbox', { name: 'New cap' });
    fireEvent.change(amount, { target: { value: '400' } });
    expect(
      within(dialog).getByText(
        'This puts the caps at $1,600, over the $1,500 ceiling. Lower another cap first.',
      ),
    ).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Save cap' }).hasAttribute('disabled')).toBe(
      true,
    );

    fireEvent.change(amount, { target: { value: '250' } });
    expect(
      within(dialog).getByText(
        'All three caps together can’t go over $1,500. With this change: $1,450.',
      ),
    ).toBeTruthy();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Reason' }), {
      target: { value: REASON },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save cap' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.body).toEqual({
      customersCents: 70000,
      testingCents: 25000,
      reserveCents: 50000,
      sonnetEnabled: true,
      applyTo: 'this_month',
      reason: REASON,
    });
  });

  it('asks for a reason before pausing AI', async () => {
    const { writes } = setup({
      routes: {
        'POST /v1/platform/settings/ai-budget/pause': {
          status: 200,
          body: { ...BUDGET, paused: true },
        },
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Pause AI' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Pause AI' }));
    expect(writes()).toHaveLength(0);
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: REASON } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Pause AI' }));
    await waitFor(() => expect(writes()[0]?.path).toBe('/v1/platform/settings/ai-budget/pause'));
    expect(writes()[0]!.body).toEqual({ reason: REASON });
  });

  it('caps the release at the free reserve (785:48801)', async () => {
    const { writes } = setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Release reserve' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Amount' }), {
      target: { value: '500' },
    });
    expect(
      within(dialog).getByText('Only $419 of reserve is free to move. Try a smaller amount.'),
    ).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Move $500' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(within(dialog).queryByLabelText(/Password/)).toBeNull();
    expect(writes()).toHaveLength(0);
  });

  it('confirms it is you first when the step-up is older than 15 minutes (785:48886)', async () => {
    const stale = me({
      stepUpExpiresAt: new Date(NOW.getTime() + 60 * 60_000).toISOString(),
    });
    const { writes } = setup({
      me: stale,
      routes: {
        'POST /v1/platform/step-up': {
          status: 200,
          body: { expiresAt: '2026-12-11T12:00:00Z', mfaVerified: true },
        },
        'POST /v1/platform/settings/ai-budget/reserve-release': { status: 200, body: BUDGET },
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Release reserve' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Confirm it’s you')).toBeTruthy();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Amount' }), {
      target: { value: '100' },
    });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Reason' }), {
      target: { value: REASON },
    });
    fireEvent.change(within(dialog).getByLabelText(/Password/), {
      target: { value: 'secret-pass' },
    });
    fireEvent.change(
      within(dialog).getByRole('textbox', { name: 'Code from your authenticator app' }),
      {
        target: { value: '123 456' },
      },
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move $100' }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[0]).toMatchObject({
      path: '/v1/platform/step-up',
      body: { password: 'secret-pass', code: '123456' },
    });
    expect(writes()[1]).toMatchObject({
      path: '/v1/platform/settings/ai-budget/reserve-release',
      body: { to: 'customers', amountCents: 10000, reason: REASON },
    });
  });

  it('shows the stale-check warning when the API refuses the release', async () => {
    setup({
      routes: {
        'POST /v1/platform/settings/ai-budget/reserve-release': {
          status: 403,
          body: { error: { code: 'reauthentication_required', message: 'Confirm again.' } },
        },
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Release reserve' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Amount' }), {
      target: { value: '100' },
    });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Reason' }), {
      target: { value: REASON },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move $100' }));
    expect(
      await within(dialog).findByText(
        'Your last check was more than 15 minutes ago. Confirm it’s you again to move reserve.',
      ),
    ).toBeTruthy();
    expect(within(dialog).getByLabelText(/Password/)).toBeTruthy();
  });

  it('grants a pack once per dialog with an Idempotency-Key (785:49055)', async () => {
    const { writes } = setup({
      routes: {
        'POST /v1/platform/ai/test-list/org-2/packs': {
          status: 201,
          body: {
            packId: 'p-1',
            organizationId: 'org-2',
            sizeCredits: 5000,
            grantedAt: '2026-12-10T12:00:00Z',
            expiresAt: '2027-06-10T12:00:00Z',
            requestId: 'req-1',
          },
        },
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Grant credits to Cedar Agency' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Reason' }), {
      target: { value: REASON },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Grant 5,000 credits' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.body).toEqual({ sizeCredits: 5000, requestId: 'req-1', reason: REASON });
    expect(writes()[0]!.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
  });
});
