import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { InsightsAdoptionScreen } from '../src/components/screens/InsightsAdoptionScreen';
import { expectNoAxeViolations } from './axe';

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
  windowDays: 30,
  activeMembers: 12,
  membersWithWork: 8,
  meetingsHeld: 5,
  computedAt: '2026-09-20T10:00:00.000Z',
};

describe('InsightsAdoptionScreen', () => {
  it('renders the adoption metrics as an accessible table', async () => {
    const { container } = mount({ body: ADOPTION });

    const table = (await screen.findByRole('table', {
      name: /organization adoption over the last 30 days/i,
    })) as HTMLTableElement;
    const rows = within(table);
    expect(rows.getByRole('row', { name: /Active members 12/i })).toBeTruthy();
    expect(rows.getByRole('row', { name: /Members who created work 8/i })).toBeTruthy();
    expect(rows.getByRole('row', { name: /Meetings held 5/i })).toBeTruthy();

    await expectNoAxeViolations(container);
  });

  it('surfaces a work.read refusal rather than rendering blank', async () => {
    mount({
      body: { error: { code: 'forbidden', message: 'You need work.read.', correlationId: 'c' } },
      status: 403,
    });

    expect(await screen.findByText('You need work.read.')).toBeTruthy();
  });
});
