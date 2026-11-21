import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import type { BusinessFactView } from '../src/lib/api/business-memory';
import type { AiCreditsView } from '../src/lib/api/ai-credits';
import { BusinessMemoryScreen } from '../src/components/ai-admin/BusinessMemoryScreen';
import { AiCreditsBlock } from '../src/components/ai-admin/AiCreditsBlock';
import { filterCounts, monthsBetween } from '../src/components/ai-admin/business-memory-model';
import { expectNoAxeViolations } from './axe';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/northstar/admin/ai/memory',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

/** Plan 62 — Business Memory (Figma G11 771:45216, fixes 788:49713) and the AI credits block (G14). */

const ORG = 'https://api.example.test/v1/organizations/northstar';
const FACTS = `${ORG}/business-memory/facts`;
const OMAR = '11111111-1111-4111-8111-111111111111';
const SARA = '22222222-2222-4222-8222-222222222222';
const CEDAR = '33333333-3333-4333-8333-333333333333';

type Reply = { status: number; body: unknown } | 'offline';
type Route = Reply | ((body: unknown) => Reply);

function fact(overrides: Partial<BusinessFactView>): BusinessFactView {
  return {
    id: 'f-1',
    entityType: 'client',
    entityId: CEDAR,
    fact: 'Cedar Foods wants invoices in AED.',
    category: 'billing',
    sourceHref: null,
    audience: 'finance',
    status: 'approved',
    proposedVia: 'member',
    ownerUserId: OMAR,
    proposedByUserId: OMAR,
    approvedByUserId: OMAR,
    approvedAt: '2026-11-04T09:00:00.000Z',
    lastConfirmedAt: '2026-11-04T09:00:00.000Z',
    retiredAt: null,
    stale: false,
    createdAt: '2026-11-01T09:00:00.000Z',
    updatedAt: '2026-11-04T09:00:00.000Z',
    ...overrides,
  };
}

const LIST = [
  fact({}),
  fact({
    id: 'f-2',
    fact: 'Lina Haddad signs off all packaging artwork.',
    audience: 'internal',
    status: 'proposed',
    proposedVia: 'ai',
    ownerUserId: SARA,
    proposedByUserId: SARA,
    approvedByUserId: null,
    approvedAt: null,
    lastConfirmedAt: null,
    updatedAt: '2026-11-20T09:00:00.000Z',
  }),
  fact({
    id: 'f-3',
    entityType: 'process',
    entityId: null,
    fact: 'Print proofs go to Al Noor Printing.',
    audience: 'internal',
    stale: true,
    lastConfirmedAt: '2026-04-10T09:00:00.000Z',
  }),
  fact({ id: 'f-4', fact: 'Old rule.', status: 'retired', retiredAt: '2026-10-01T09:00:00.000Z' }),
];

function mount(routes: Record<string, Route>, role = 'owner', node?: 'credits') {
  const calls: { key: string; body: unknown }[] = [];
  const api = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input)}`;
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ key, body });
      const route = routes[key] ?? { status: 404, body: { code: 'not_found' } };
      const reply = typeof route === 'function' ? route(body) : route;
      if (reply === 'offline') return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve(
        new Response(JSON.stringify(reply.body), {
          status: reply.status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queries.setQueryData(
    ['shell', 'organizations'],
    [
      {
        id: 'o-1',
        slug: 'northstar',
        name: 'Northstar Studio',
        audience: 'internal',
        role,
        clientOrganizationName: null,
      },
    ],
  );
  const result = render(
    <QueryClientProvider client={queries}>
      {node === 'credits' ? (
        <AiCreditsBlock organizationSlug="northstar" client={api} placement="plan" />
      ) : (
        <BusinessMemoryScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          client={api}
          now={() => new Date('2026-11-21T09:00:00.000Z')}
        />
      )}
    </QueryClientProvider>,
  );
  return { ...result, calls };
}

const NAMES: Record<string, Route> = {
  [`GET ${ORG}/members?limit=200`]: {
    status: 200,
    body: {
      members: [
        { userId: OMAR, displayName: 'Omar Adel', role: 'owner' },
        { userId: SARA, displayName: 'Sara Nasser', role: 'member' },
      ],
      nextAfter: null,
    },
  },
  [`GET ${ORG}/client-organizations?includeArchived=true`]: {
    status: 200,
    body: {
      clientOrganizations: [
        { id: CEDAR, name: 'Cedar Foods', createdAt: '', updatedAt: '', archivedAt: null },
      ],
    },
  },
};

describe('Business Memory model', () => {
  it('counts All without retired facts, and whole months since the last check', () => {
    expect(filterCounts(LIST)).toEqual({ all: 3, waiting: 1, check: 1, retired: 1 });
    expect(monthsBetween('2026-04-10T09:00:00.000Z', new Date('2026-11-21T09:00:00.000Z'))).toBe(7);
  });
});

describe('BusinessMemoryScreen', () => {
  it('lists facts with names, states and decisions, and approves a waiting fact', async () => {
    let approved = false;
    const { container, calls } = mount({
      ...NAMES,
      [`GET ${FACTS}?status=all`]: () => ({
        status: 200,
        body: {
          facts: approved
            ? LIST.map((f) => (f.id === 'f-2' ? { ...f, status: 'approved' } : f))
            : LIST,
        },
      }),
      [`POST ${FACTS}/f-2/approve`]: () => {
        approved = true;
        return { status: 200, body: { ...LIST[1], status: 'approved' } };
      },
    });
    expect(await screen.findByText('Cedar Foods wants invoices in AED.')).toBeTruthy();
    expect(
      await screen.findByText(
        'Client · Cedar Foods · Finance people only · Approved by Omar Adel · checked Nov 4',
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Suggested by TManage AI for Sara Nasser/u)).toBeTruthy();
    expect(screen.getByText('Way of working · Team · Not checked for 7 months')).toBeTruthy();
    expect(screen.queryByText('Old rule.')).toBeNull();
    expect(screen.getByRole('button', { name: /All\s*3/u }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByRole('button', { name: 'Still true' })).toBeTruthy();
    await expectNoAxeViolations(container);

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Approved. TManage AI can use this fact now.')).toBeTruthy();
    expect(calls.some((call) => call.key === `POST ${FACTS}/f-2/approve`)).toBe(true);
  });

  it('filters to retired facts, which offer no decisions', async () => {
    mount({ ...NAMES, [`GET ${FACTS}?status=all`]: { status: 200, body: { facts: LIST } } });
    fireEvent.click(await screen.findByRole('button', { name: /Retired\s*1/u }));
    const list = document.querySelector<HTMLElement>('.tm-aia-facts')!;
    expect(within(list).getByText('Old rule.')).toBeTruthy();
    expect(within(list).queryByRole('button')).toBeNull();
    expect(screen.getByText('Showing 1 of 1 fact')).toBeTruthy();
  });

  it('checks the fact before saving, sends only the change, and retires behind a confirmation', async () => {
    const { calls } = mount({
      ...NAMES,
      [`GET ${FACTS}?status=all`]: { status: 200, body: { facts: [LIST[0]] } },
      [`PATCH ${FACTS}/f-1`]: { status: 200, body: LIST[0] },
      [`POST ${FACTS}/f-1/retire`]: { status: 200, body: { ...LIST[0], status: 'retired' } },
    });
    fireEvent.click(await screen.findByRole('button', { name: /Edit: Cedar Foods/u }));
    const dialog = screen.getByRole('dialog', { name: 'Edit fact' });
    const input = within(dialog).getByRole('textbox', { name: 'Fact' });
    expect(document.activeElement).toBe(input);
    expect(within(dialog).getByText('One line. 34 of 500 characters.')).toBeTruthy();

    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      await within(dialog).findByText('Write the fact in one line, up to 500 characters.'),
    ).toBeTruthy();
    expect(calls.some((call) => call.key.startsWith('PATCH'))).toBe(false);

    fireEvent.change(input, { target: { value: 'Cedar Foods wants invoices in AED and USD.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.find((call) => call.key === `PATCH ${FACTS}/f-1`)?.body).toEqual({
      fact: 'Cedar Foods wants invoices in AED and USD.',
    });

    fireEvent.click(screen.getByRole('button', { name: /Edit: Cedar Foods/u }));
    const again = screen.getByRole('dialog', { name: 'Edit fact' });
    fireEvent.click(within(again).getByRole('button', { name: 'Retire this fact' }));
    expect(
      within(again).getByText(
        'Retire this fact? TManage AI stops using it. This can’t be reversed.',
      ),
    ).toBeTruthy();
    fireEvent.click(within(again).getByRole('button', { name: 'Retire fact' }));
    expect(await screen.findByText('Fact retired. TManage AI no longer uses it.')).toBeTruthy();
    expect(calls.some((call) => call.key === `POST ${FACTS}/f-1/retire`)).toBe(true);
  });

  it('adds a fact as a proposal about the company', async () => {
    const { calls } = mount({
      ...NAMES,
      [`GET ${FACTS}?status=all`]: { status: 200, body: { facts: [] } },
      [`POST ${FACTS}`]: { status: 201, body: LIST[1] },
    });
    expect(await screen.findByText('No facts yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add a fact' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a fact' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Fact' }), {
      target: { value: 'Rush jobs cost 1.5 times the normal rate.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add fact' }));
    expect(
      await screen.findByText('Fact added. It waits for approval before TManage AI uses it.'),
    ).toBeTruthy();
    expect(calls.find((call) => call.key === `POST ${FACTS}`)?.body).toEqual({
      entityType: 'company',
      entityId: null,
      fact: 'Rush jobs cost 1.5 times the normal rate.',
      category: 'other',
      audience: 'internal',
    });
  });

  it('shows a member the facts read-only, and the error state with a retry', async () => {
    let fail = true;
    mount(
      {
        ...NAMES,
        [`GET ${FACTS}?status=all`]: () =>
          fail ? 'offline' : { status: 200, body: { facts: [LIST[0]] } },
      },
      'member',
    );
    expect(
      await screen.findByText(
        'Couldn’t load Business Memory. Check your connection and try again.',
      ),
    ).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Cedar Foods wants invoices in AED.')).toBeTruthy();
    expect(
      screen.getByText('You can read these facts. People who manage AI settings can change them.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Edit:/u })).toBeNull();
  });
});

const CREDITS: AiCreditsView = {
  periodStart: '2026-11-01',
  resetsOn: '2026-12-01',
  allowanceCredits: 2000,
  limitedBy: 'plan',
  raisedBySupport: false,
  packCreditsThisMonth: 0,
  usedCredits: 1860,
  heldCredits: 0,
  remainingCredits: 140,
  packBalanceCredits: 5000,
  packs: [
    { remainingCredits: 5000, grantedAt: '2026-11-02', expiresAt: '2027-05-31T00:00:00.000Z' },
  ],
  memberShareCredits: 400,
  openRequest: null,
  canRequestPack: true,
};

describe('AiCreditsBlock (G14)', () => {
  it('draws the low meter in words, extra credits, and sends one pack request', async () => {
    let open = false;
    const { calls } = mount(
      {
        [`GET ${ORG}/ai/credits`]: () => ({
          status: 200,
          body: open
            ? {
                ...CREDITS,
                canRequestPack: false,
                openRequest: { id: 'r', status: 'open', requestedAt: '2026-11-20T09:00:00.000Z' },
              }
            : CREDITS,
        }),
        [`POST ${ORG}/ai/credits/pack-requests`]: () => {
          open = true;
          return { status: 201, body: { id: 'r', status: 'open', requestedAt: '2026-11-20' } };
        },
      },
      'owner',
      'credits',
    );
    const meter = await screen.findByRole('meter', { name: 'AI credits this month' });
    expect(meter.getAttribute('aria-valuetext')).toBe('1,860 of 2,000 used');
    expect(meter.getAttribute('data-tone')).toBe('low');
    expect(screen.getByText('Extra credits: 5,000 · use by May 31')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Get more credits' }));
    expect(await screen.findByText(/You asked for more credits on Nov 20/u)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Get more credits' })).toBeNull();
    expect(calls.filter((call) => call.key.startsWith('POST')).length).toBe(1);
  });

  it('draws nothing on the Plan page where the workspace has no TManage AI', async () => {
    const { container, calls } = mount({}, 'owner', 'credits');
    await waitFor(() => expect(calls.length).toBe(1));
    expect(container.textContent).toBe('');
  });
});
