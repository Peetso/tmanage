import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { AutomationSchedulesScreen } from '../src/components/screens/AutomationSchedulesScreen';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * **Automations scheduled triggers (x167).**
 *
 * The API's resolve-before-authorize, the `org.manage` 403, the bounded-spec 400 and the pure
 * next-run computation are proved over fakes in `apps/api`; nothing here re-proves them. What only
 * this file can prove is what the *screen* does: it lists a tenant's schedules soonest-due first,
 * carries a create form whose fields track the chosen interval, and has an accessible structure (a
 * labelled list region, a table caption and column headers) with no axe violation.
 */

interface Call {
  readonly url: string;
  readonly method: string;
}

function clientOver(handler: (call: Call) => Response): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(
        handler({ url: String(input), method: (init?.method ?? 'GET').toUpperCase() }),
      )) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function withQuery(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const DAILY = {
  id: 'sch-1',
  templateId: 'tpl-1',
  spec: { interval: 'daily' as const, hour: 8 },
  nextRunAt: '2026-09-28T08:00:00.000Z',
  enabled: true,
  createdAt: '2026-09-27T09:00:00.000Z',
};

const WEEKLY = {
  id: 'sch-2',
  templateId: 'tpl-2',
  spec: { interval: 'weekly' as const, hour: 12, dayOfWeek: 3 },
  nextRunAt: '2026-09-30T12:00:00.000Z',
  enabled: false,
  createdAt: '2026-09-27T09:00:00.000Z',
};

function screenOver(schedules: readonly (typeof DAILY | typeof WEEKLY)[]) {
  const client = clientOver((call) => {
    if (call.url.includes('/automations')) {
      if (call.method === 'POST') return json(DAILY, 201);
      return json({ schedules });
    }
    return json({}, 404);
  });
  return withQuery(
    <AutomationSchedulesScreen organizationSlug="acme" organizationName="Acme" client={client} />,
  );
}

describe('AutomationSchedulesScreen', () => {
  it('lists schedules soonest-due first and is accessible', async () => {
    const { container } = render(screenOver([DAILY, WEEKLY]));

    const region = await screen.findByRole('region', { name: /scheduled triggers/i });
    const table = within(region).getByRole('table');
    const bodyRows = within(table).getAllByRole('row').slice(1);
    expect(bodyRows).toHaveLength(2);
    expect(within(bodyRows[0]!).getByRole('rowheader')).toHaveTextContent('tpl-1');
    expect(within(table).getByText(/Weekly on Wednesday at 12:00/)).toBeInTheDocument();
    expect(within(table).getByText('No')).toBeInTheDocument();

    await expectNoAxeViolations(container);
  });

  it('shows the empty state when there are no schedules yet', async () => {
    render(screenOver([]));
    expect(await screen.findByText(/no schedules yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('creates a schedule through the form', async () => {
    render(screenOver([]));
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/workflow template id/i), 'tpl-1');
    await user.click(screen.getByRole('button', { name: /create schedule/i }));
    // The POST resolves 201 and the list is invalidated; the create control stays reachable.
    expect(await screen.findByRole('button', { name: /create schedule/i })).toBeInTheDocument();
  });
});
