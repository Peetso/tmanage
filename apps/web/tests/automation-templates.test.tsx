import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { AutomationTemplatesScreen } from '../src/components/screens/AutomationTemplatesScreen';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * **Automations workflow templates (x162).**
 *
 * The `org.manage` decision, the trigger/action allowlist and the tenant-scoped list are proved over
 * fakes with the real evaluator in
 * `apps/api/src/modules/automations/templates.controller.test.ts`; nothing here re-proves them. This
 * file proves only what the *screen* owns: it renders the server's templates in an accessible table
 * and shows the empty state, both with no axe violation jsdom can detect.
 */

function clientReturning(templates: readonly unknown[]): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: (() =>
      Promise.resolve(
        new Response(JSON.stringify({ templates }), {
          status: 200,
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

const template = {
  id: 'workflow-template-01',
  name: 'Notify owner on new work',
  triggerKind: 'work_item_created',
  actionKind: 'notify_owner',
  config: {},
  enabled: true,
  createdBy: 'user-1',
  createdAt: '2026-09-27T10:00:00.000Z',
};

describe('AutomationTemplatesScreen', () => {
  it('renders the templates in an accessible table', async () => {
    const { container } = render(
      withQuery(
        <AutomationTemplatesScreen
          organizationSlug="acme"
          organizationName="Acme"
          client={clientReturning([template])}
        />,
      ),
    );

    await waitFor(() => expect(screen.getByText('Notify owner on new work')).toBeInTheDocument());
    expect(screen.getByRole('columnheader', { name: 'Trigger' })).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('shows an accessible empty state when there are none', async () => {
    const { container } = render(
      withQuery(
        <AutomationTemplatesScreen
          organizationSlug="acme"
          organizationName="Acme"
          client={clientReturning([])}
        />,
      ),
    );

    await waitFor(() => expect(screen.getByText('No templates yet')).toBeInTheDocument());
    await expectNoAxeViolations(container);
  });
});
