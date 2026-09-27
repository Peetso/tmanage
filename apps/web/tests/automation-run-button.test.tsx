import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { AutomationRunButton } from '../src/components/screens/AutomationRunButton';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * **Automations run control (x163).**
 *
 * The `org.manage` decision, resolve-before-authorize, the disabled-template 409 and the in-app-only
 * execution boundary are proved over fakes with the real evaluator in
 * `apps/api/src/modules/automations/run.controller.test.ts`; nothing here re-proves them. This file
 * proves only what the *control* owns: it renders an accessible run button and announces the run's
 * outcome, with no axe violation jsdom can detect.
 */

function clientReturning(run: Record<string, unknown>): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: (() =>
      Promise.resolve(
        new Response(JSON.stringify(run), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
      )) as typeof globalThis.fetch,
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

const succeededRun = {
  id: 'workflow-run-01',
  templateId: 'workflow-template-01',
  status: 'succeeded',
  detail: { outcome: 'executed', effect: 'Notified the work owner in-app.' },
  startedAt: '2026-09-27T11:00:00.000Z',
  finishedAt: '2026-09-27T11:00:00.000Z',
};

describe('AutomationRunButton', () => {
  it('renders an accessible run button', async () => {
    const { container } = render(
      withQuery(
        <AutomationRunButton
          organizationSlug="acme"
          templateId="workflow-template-01"
          templateName="Notify owner on new work"
          client={clientReturning(succeededRun)}
        />,
      ),
    );

    expect(
      screen.getByRole('button', { name: 'Run Notify owner on new work' }),
    ).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('announces the run outcome after pressing Run', async () => {
    const { container } = render(
      withQuery(
        <AutomationRunButton
          organizationSlug="acme"
          templateId="workflow-template-01"
          templateName="Notify owner on new work"
          client={clientReturning(succeededRun)}
        />,
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Run Notify owner on new work' }));
    await waitFor(() => expect(screen.getByText('Run succeeded')).toBeInTheDocument());
    await expectNoAxeViolations(container);
  });
});
