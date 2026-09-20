import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { InsightsScreen } from '../src/components/screens/InsightsScreen';
import { expectNoAxeViolations } from './axe';

/**
 * INS-03 — the project insights dashboard (x109). The screen reads two endpoints; the fake fetch
 * routes by path so each read can be given its own body and status independently, the way a caller
 * with one capability but not the other actually experiences them.
 */
type Reply = { body: unknown; status?: number };

function mount(replies: { deliveryFlow: Reply; approvalCycle: Reply }) {
  const routed: typeof globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    const reply = url.includes('/delivery-flow') ? replies.deliveryFlow : replies.approvalCycle;
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof globalThis.fetch;

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
      <InsightsScreen
        organizationSlug="northstar"
        organizationName="Northstar Studio"
        projectId="project-1"
        client={client}
      />
    </QueryClientProvider>,
  );
}

const DELIVERY_FLOW = {
  projectId: 'project-1',
  counts: {
    backlog: 3,
    ready: 1,
    in_progress: 2,
    blocked: 0,
    internal_review: 1,
    done: 4,
    archived: 0,
  },
  itemCount: 11,
  computedAt: '2026-09-20T10:00:00.000Z',
};

const APPROVAL_CYCLE = {
  projectId: 'project-1',
  metrics: {
    // Two decided approvals, 4 days of turnaround between them -> mean 2 d.
    approved: { count: 2, decidedCount: 2, totalDurationMs: 4 * 24 * 60 * 60 * 1000 },
    changes_requested: { count: 1, decidedCount: 1, totalDurationMs: 60 * 60 * 1000 },
    invalidated: { count: 1, decidedCount: 0, totalDurationMs: 0 },
  },
  approvalCount: 4,
  computedAt: '2026-09-20T10:00:00.000Z',
};

const EMPTY_FLOW = {
  projectId: 'project-1',
  counts: {
    backlog: 0,
    ready: 0,
    in_progress: 0,
    blocked: 0,
    internal_review: 0,
    done: 0,
    archived: 0,
  },
  itemCount: 0,
  computedAt: '2026-09-20T10:00:00.000Z',
};

const EMPTY_CYCLE = {
  projectId: 'project-1',
  metrics: {
    approved: { count: 0, decidedCount: 0, totalDurationMs: 0 },
    changes_requested: { count: 0, decidedCount: 0, totalDurationMs: 0 },
    invalidated: { count: 0, decidedCount: 0, totalDurationMs: 0 },
  },
  approvalCount: 0,
  computedAt: '2026-09-20T10:00:00.000Z',
};

function refusal(message: string) {
  return { body: { error: { code: 'forbidden', message, correlationId: 'c' } }, status: 403 };
}

describe('InsightsScreen', () => {
  it('renders both reads as tables: statuses with a total, and outcomes with mean turnaround', async () => {
    const { container } = mount({
      deliveryFlow: { body: DELIVERY_FLOW },
      approvalCycle: { body: APPROVAL_CYCLE },
    });

    const deliveryTable = (await screen.findByRole('table', {
      name: /work items by workflow status/i,
    })) as HTMLTableElement;
    const delivery = within(deliveryTable);
    expect(delivery.getByRole('row', { name: /In progress 2/i })).toBeTruthy();
    expect(delivery.getByRole('row', { name: /Done 4/i })).toBeTruthy();
    // itemCount total in the footer, not the sum of any single status.
    expect(delivery.getByRole('row', { name: /Total 11/i })).toBeTruthy();

    const approvalTable = screen.getByRole('table', { name: /approvals by terminal outcome/i });
    const approval = within(approvalTable);
    // Two approvals decided over 2 days each -> mean 2 d; invalidated has no decision time -> em dash.
    expect(approval.getByRole('row', { name: /Approved 2 2 2 d/i })).toBeTruthy();
    expect(approval.getByRole('row', { name: /Changes requested 1 1 1 h/i })).toBeTruthy();
    expect(approval.getByRole('row', { name: /Invalidated 1 0 —/i })).toBeTruthy();

    await expectNoAxeViolations(container);
  });

  it('shows every count at zero for an empty project — no invented numbers', async () => {
    mount({ deliveryFlow: { body: EMPTY_FLOW }, approvalCycle: { body: EMPTY_CYCLE } });

    expect(await screen.findByText(/No work items you can read in this project yet/i)).toBeTruthy();
    expect(
      screen.getByText(/No approvals have reached a decision in this project yet/i),
    ).toBeTruthy();
    const deliveryTable = screen.getByRole('table', { name: /work items by workflow status/i });
    expect(within(deliveryTable).getByRole('row', { name: /Total 0/i })).toBeTruthy();
  });

  it('surfaces a work.read refusal in the delivery panel while the approval panel still renders', async () => {
    mount({
      deliveryFlow: refusal('You need work.read.'),
      approvalCycle: { body: APPROVAL_CYCLE },
    });

    expect(await screen.findByText('You need work.read.')).toBeTruthy();
    // The independent approval read still renders its table.
    expect(
      await screen.findByRole('table', { name: /approvals by terminal outcome/i }),
    ).toBeTruthy();
  });
});
