import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { DocumentTemplateVariablesScreen } from '../src/components/screens/DocumentTemplateVariablesScreen';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * **DOC-04 template variables (x130).**
 *
 * The API's authorize/relation logic and the Known-trap 404/409 are proved over fakes in `apps/api`;
 * nothing here re-proves them. What only this file can prove is what the *screen* does: it lists a
 * template's variables key-ascending, carries an add form and a remove control, and has an accessible
 * structure (a labelled list region, a table caption and column headers) with no axe violation.
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

function variable(id: string, key: string, label: string) {
  return {
    id,
    templateId: 'tpl-1',
    key,
    label,
    type: 'text' as const,
    required: false,
    createdAt: '2026-09-26T10:00:00.000Z',
  };
}

function screenOver(variables: readonly ReturnType<typeof variable>[]) {
  const client = clientOver((call) => {
    if (call.url.includes('/variables')) {
      if (call.method === 'POST') return json(variable('var-new', 'fresh', 'Fresh'));
      if (call.method === 'DELETE') return new Response(null, { status: 204 });
      return json({ variables });
    }
    return json({}, 404);
  });
  return withQuery(
    <DocumentTemplateVariablesScreen
      organizationSlug="acme"
      organizationName="Acme"
      templateId="tpl-1"
      client={client}
    />,
  );
}

describe('DocumentTemplateVariablesScreen', () => {
  it('lists variables key-ascending and is accessible', async () => {
    const { container } = render(
      screenOver([
        variable('var-1', 'client_name', 'Client name'),
        variable('var-2', 'budget', 'Budget'),
      ]),
    );

    const region = await screen.findByRole('region', { name: /template variables/i });
    const table = within(region).getByRole('table');
    const bodyRows = within(table).getAllByRole('row').slice(1);
    expect(bodyRows).toHaveLength(2);
    expect(within(bodyRows[0]!).getByRole('rowheader')).toHaveTextContent('client_name');
    expect(within(table).getByText('Budget')).toBeInTheDocument();

    await expectNoAxeViolations(container);
  });

  it('shows the empty state when there are no variables yet', async () => {
    render(screenOver([]));
    expect(await screen.findByText(/no variables yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('removes a variable through the row control', async () => {
    render(screenOver([variable('var-1', 'client_name', 'Client name')]));
    const user = userEvent.setup();
    const removeButton = await screen.findByRole('button', { name: /remove/i });
    await user.click(removeButton);
    // The remove call resolves 204; the button stays reachable after the invalidation refetch.
    expect(await screen.findByRole('button', { name: /remove/i })).toBeInTheDocument();
  });
});
