import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { InsightsAdoptionScreen } from '../src/components/screens/InsightsAdoptionScreen';
import { expectNoAxeViolations } from './axe';

// The app shell mounts MembershipGoneGate, which calls useRouter; jsdom has no Next app-router
// context, so the router is stubbed for the mount.
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

/**
 * INS-06 — the org-wide adoption screen (x133). The screen reads a single endpoint; the fake fetch
 * returns one body/status so the read can be given a success body or a refusal the way a caller
 * actually experiences it.
 */
type Reply = { body: unknown; status?: number };

function mount(reply: Reply) {
  const routed: typeof globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    )) as typeof globalThis.fetch;

  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: routed,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={query}>
      <InsightsAdoptionScreen
        organizationSlug="northstar"
        organizationName="Northstar Studio"
        client={client}
      />
    </QueryClientProvider>,
  );
}

const ADOPTION = {
  windowDays: 14,
  activeMembers: 12,
  membersWithWork: 8,
  meetingsHeld: 5,
  committedDate: { dated: 17, total: 25, previousDated: 37, previousTotal: 50 },
  channels: { total: 40, withoutWork: 12 },
  unhashedDeliverables: { current: 3, previous: 5 },
  decisionsRecorded: { decisionLog: 18, approvals: 12 },
  gaps: [
    { id: 'chat_work_untriaged', count: 9, projectCount: 3, projectName: null },
    { id: 'client_files_internal', count: 0, projectCount: 0, projectName: null },
    { id: 'requests_uncommitted', count: 2, projectCount: 1, projectName: 'Atlas Relaunch' },
  ],
  computedAt: '2026-08-14T10:00:00.000Z',
};

describe('InsightsAdoptionScreen', () => {
  it('renders the system-quality figures and the data gaps from the API', async () => {
    const { container } = mount({ body: ADOPTION });

    const table = (await screen.findByRole('table', {
      name: /data gaps that make the record unreliable/i,
    })) as HTMLTableElement;
    const rows = within(table);
    expect(
      rows.getByRole('row', { name: /Work created from chat without triage.*3 projects.*9/i }),
    ).toBeTruthy();
    expect(rows.getByRole('row', { name: /desired date.*Atlas Relaunch.*2/i })).toBeTruthy();

    const figures = within(screen.getByRole('region', { name: 'Adoption headline figures' }));
    expect(figures.getByText('68%')).toBeTruthy();
    expect(figures.getByText('was 74%')).toBeTruthy();
    expect(figures.getByText('of 40')).toBeTruthy();
    expect(figures.getByText('down 2')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the 11 gaps' })).toBeTruthy();
    expect(screen.getByText(/1–14 August/)).toBeTruthy();

    await expectNoAxeViolations(container);
  });

  it('does not offer a link to open zero gaps', async () => {
    const clean = {
      ...ADOPTION,
      gaps: [
        { id: 'chat_work_untriaged', count: 0, projectCount: 0, projectName: null },
        { id: 'client_files_internal', count: 0, projectCount: 0, projectName: null },
        { id: 'requests_uncommitted', count: 0, projectCount: 0, projectName: null },
      ],
    };
    mount({ body: clean });

    expect(await screen.findByText('No data gaps right now.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /open the .* gap/i })).toBeNull();
  });

  it('surfaces a work.read refusal rather than rendering blank', async () => {
    mount({
      body: { error: { code: 'forbidden', message: 'You need work.read.', correlationId: 'c' } },
      status: 403,
    });

    expect(await screen.findByText('You need work.read.')).toBeTruthy();
  });
});
