import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { AutomationRunHistoryScreen } from '../src/components/screens/AutomationRunHistoryScreen';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * **Automations run history (x164).**
 *
 * The `org.manage` decision, the status allowlist and the resolve-before-authorize 404 are proved over
 * fakes with the real evaluator in
 * `apps/api/src/modules/automations/history.controller.test.ts`; nothing here re-proves them. This file
 * proves only what the *screen* owns: it renders the server's runs in an accessible table, shows the
 * empty state, and opens the detail drawer for a run — all with no axe violation jsdom can detect.
 */

const run = {
  id: 'workflow-run-01',
  templateId: 'workflow-template-01',
  status: 'succeeded',
  startedAt: '2026-09-27T11:00:00.000Z',
  finishedAt: '2026-09-27T11:00:05.000Z',
};

const detail = {
  ...run,
  detail: { outcome: 'ran', actionKind: 'notify_owner' },
};

/** A client that answers the list route with `runs` and the detail route with `detail`. */
function routedClient(runs: readonly unknown[]): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const body = /\/automations\/runs\/[^/?]+$/.test(url) ? detail : { runs };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
}

function withQuery(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('AutomationRunHistoryScreen', () => {
  it('renders the runs in an accessible table', async () => {
    const { container } = render(
      withQuery(
        <AutomationRunHistoryScreen
          organizationSlug="acme"
          organizationName="Acme"
          client={routedClient([run])}
        />,
      ),
    );

    await waitFor(() =>
      expect(screen.getByRole('columnheader', { name: 'Outcome' })).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /View details/ })).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('shows an accessible empty state when there are none', async () => {
    const { container } = render(
      withQuery(
        <AutomationRunHistoryScreen
          organizationSlug="acme"
          organizationName="Acme"
          client={routedClient([])}
        />,
      ),
    );

    await waitFor(() => expect(screen.getByText('No runs yet')).toBeInTheDocument());
    await expectNoAxeViolations(container);
  });

  it('opens the detail drawer for a run', async () => {
    const { container } = render(
      withQuery(
        <AutomationRunHistoryScreen
          organizationSlug="acme"
          organizationName="Acme"
          client={routedClient([run])}
        />,
      ),
    );

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /View details/ })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /View details/ }));

    await waitFor(() => expect(screen.getByText('Run detail')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(/"outcome": "ran"/)).toBeInTheDocument());
    await expectNoAxeViolations(container);
  });
});
