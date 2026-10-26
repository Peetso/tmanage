import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { PlanUsageScreen } from '../src/components/screens/PlanUsageScreen';
import type { PlanUsagePreviewView, PlanUsageView } from '../src/lib/api/plan-usage';

// The app shell mounts MembershipGoneGate, which calls useRouter; jsdom has no app-router context.
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

/** Figma F4 — Plan and usage: one test per key behaviour. */
const GB = 1024 ** 3;

function usage(overrides: Partial<PlanUsageView> = {}): PlanUsageView {
  return {
    billingMode: 'paid',
    planId: 'starter',
    pendingChange: false,
    currency: 'usd',
    monthlyCents: 1900,
    renewsOn: '2026-11-01',
    level: 'near',
    graceEndsOn: null,
    people: { used: 9, limit: 10, level: 'near' },
    projects: { used: 41, limit: null, level: 'normal' },
    storage: { used: 22.8 * GB, limit: 25 * GB, level: 'near' },
    clients: 23,
    nextPlanId: 'studio',
    nextPlanPeopleLimit: null,
    nextPlanStorageBytes: 100 * GB,
    measuredAt: new Date().toISOString(),
    ...overrides,
  };
}

const UPGRADE: PlanUsagePreviewView = {
  currentPlanId: 'starter',
  targetPlanId: 'studio',
  direction: 'upgrade',
  currency: 'usd',
  currentMonthlyCents: 1900,
  targetMonthlyCents: 4900,
  startsOn: '2026-10-25',
  startsToday: true,
  dueTodayCents: 677,
  daysLeft: 7,
  fullPriceFrom: '2026-11-01',
  changes: [
    {
      kind: 'people',
      feature: null,
      direction: 'gain',
      fromLimit: 10,
      toLimit: null,
      used: 9,
      fits: true,
    },
    {
      kind: 'storage',
      feature: null,
      direction: 'gain',
      fromLimit: 25 * GB,
      toLimit: 100 * GB,
      used: 22.8 * GB,
      fits: true,
    },
    {
      kind: 'feature',
      feature: 'docs_decisions',
      direction: 'gain',
      fromLimit: null,
      toLimit: null,
      used: null,
      fits: true,
    },
  ],
  overages: [],
  graceEndsOn: null,
};

interface Call {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

function mount(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        method: init?.method ?? 'GET',
        url,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      const match = Object.keys(routes)
        .sort((a, b) => b.length - a.length)
        .find((key) => url.includes(key));
      const route = match ? routes[match]! : { status: 404, body: {} };
      return Promise.resolve(
        new Response(JSON.stringify(route.body), {
          status: route.status ?? 200,
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
      <PlanUsageScreen organizationSlug="northstar" organizationName="Northstar" client={client} />
    </QueryClientProvider>,
  );
  return calls;
}

describe('PlanUsageScreen', () => {
  it('beta_free: "Free during the beta", no price, no plan change, no payment', async () => {
    const calls = mount({
      '/billing/plan-usage': {
        body: usage({
          billingMode: 'beta_free',
          people: { used: 14, limit: null, level: 'normal' },
        }),
      },
    });
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Free during the beta' }),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Billing' })).toBeTruthy();
    expect(
      screen.getByText('Northstar is on the TManage beta. Everything is free while the beta runs.'),
    ).toBeTruthy();
    expect(screen.getByText('14 · all included')).toBeTruthy();
    expect(screen.getByText('None')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Send feedback' })).toHaveAttribute('href', '/contact');
    expect(screen.queryByRole('button', { name: 'Change plan' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'See all plans' })).toBeNull();
    expect(screen.queryByText(/\$\d/u)).toBeNull();
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('shows the near-limit alert, amber meters and the next bill', async () => {
    mount({ '/billing/plan-usage': { body: usage() } });
    expect(
      await screen.findByText(
        'You are close to your Starter limits. Studio has no limit on people and 100 GB of storage.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('9 of 10')).toBeTruthy();
    expect(screen.getByText('22.8 of 25 GB')).toBeTruthy();
    expect(screen.getByText('1 seat left. After that you need Studio.')).toBeTruthy();
    expect(screen.getByText('2.2 GB free. Uploads stop at 25 GB.')).toBeTruthy();
    expect(screen.getByText('41 active')).toBeTruthy();
    expect(screen.getByText('$19 a month, flat · renews 1 November')).toBeTruthy();
    expect(
      screen.getByText('Next bill: $19 on 1 November. Clients are never billed.'),
    ).toBeTruthy();
    const bars = screen.getAllByRole('progressbar');
    expect(bars).toHaveLength(2);
    expect(bars[0]!.closest('[data-level]')?.getAttribute('data-level')).toBe('near');
  });

  it('shows the over-limit alert with the grace date and red notes', async () => {
    mount({
      '/billing/plan-usage': {
        body: usage({
          level: 'over',
          graceEndsOn: '2026-12-01',
          people: { used: 11, limit: 10, level: 'over' },
          storage: { used: 26.4 * GB, limit: 25 * GB, level: 'over' },
        }),
      },
    });
    expect(await screen.findByText(/Free up space or change plan by 1 December\.$/u)).toBeTruthy();
    expect(screen.getByText('1 over the limit. You cannot invite anyone new.')).toBeTruthy();
    expect(
      screen.getByText('1.4 GB over. New uploads are paused. Nothing is deleted.'),
    ).toBeTruthy();
  });

  it('previews the prorated upgrade and records the change request on confirm', async () => {
    const calls = mount({
      '/billing/plan-usage/preview': { body: UPGRADE },
      '/billing/plan-usage': { body: usage() },
      '/billing/plan-change-requests': {
        status: 201,
        body: {
          id: 'r1',
          targetPlanCode: 'studio',
          effectiveOn: '2026-10-25',
          note: null,
          status: 'pending',
          createdBy: 'u1',
          createdAt: '2026-10-25T00:00:00.000Z',
        },
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Change plan' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change to Studio?' });
    expect(await screen.findByText('$6.77')).toBeTruthy();
    expect(dialog.textContent).toContain('Today, 25 October');
    expect(dialog.textContent).toContain('$49 a month, flat (now $19)');
    expect(dialog.textContent).toContain('No limit on internal people (now 10)');
    expect(dialog.textContent).toContain('100 GB storage (now 25 GB)');
    expect(dialog.textContent).toContain(
      'Prorated: you pay only the difference for the 7 days left this month. From 1 November you pay $49 a month.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Change to Studio' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toContain('/billing/plan-change-requests');
    expect(post?.body).toEqual({ targetPlanCode: 'studio', effectiveOn: '2026-10-25' });
  });

  it('warns about the storage overage on a downgrade and charges nothing today', async () => {
    mount({
      '/billing/plan-usage/preview': {
        body: {
          ...UPGRADE,
          currentPlanId: 'studio',
          targetPlanId: 'starter',
          direction: 'downgrade',
          currentMonthlyCents: 4900,
          targetMonthlyCents: 1900,
          startsOn: '2026-11-01',
          startsToday: false,
          dueTodayCents: 0,
          changes: [
            {
              kind: 'storage',
              feature: null,
              direction: 'lose',
              fromLimit: 100 * GB,
              toLimit: 25 * GB,
              used: 38.5 * GB,
              fits: false,
            },
          ],
          overages: [{ kind: 'storage', limit: 25 * GB, over: 13.5 * GB }],
          graceEndsOn: '2026-12-01',
        } satisfies PlanUsagePreviewView,
      },
      '/billing/plan-usage': {
        body: usage({ planId: 'studio', nextPlanId: null, level: 'normal' }),
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Change plan' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change to Starter?' });
    await waitFor(() =>
      expect(dialog.textContent).toContain('$0. You keep Studio until 1 November.'),
    );
    expect(dialog.textContent).toContain('1 November, when this month ends');
    expect(dialog.textContent).toContain('Storage drops to 25 GB (you use 38.5 GB)');
    expect(dialog.textContent).toContain(
      'You will be 13.5 GB over the Starter storage. Nothing is deleted, but new uploads pause until you are under 25 GB. You have until 1 December.',
    );
  });

  it('renders the API refusal rather than a blank page', async () => {
    mount({
      '/billing/plan-usage': {
        status: 403,
        body: { error: { code: 'forbidden', message: 'No access.', correlationId: 'c' } },
      },
    });
    expect(await screen.findByText('No access.')).toBeTruthy();
  });
});
