import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { AutomationTemplateEditScreen } from '../src/components/screens/AutomationTemplateEditScreen';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * Automations template edit web (x189). The API's tenant scoping, the `org.manage` gate and the
 * 404-before-authorize order are proved in the controller unit test and (in the chain) the DB suite;
 * nothing here re-proves them. What only this file can prove is what the *screen* does with the
 * org-scoped list: it prefills the edit form from the named template, sends the edit as a `PATCH` to
 * that template's id, renders a not-found state for an id the list does not contain, and is
 * axe-clean (A11Y-01).
 */

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: string | undefined;
}

function clientOver(handler: (call: Call) => Response): { client: ApiClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : undefined,
      };
      calls.push(call);
      if (call.method === 'GET') {
        return Promise.resolve(json({ templates: [TEMPLATE] }));
      }
      return Promise.resolve(handler(call));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
  return { client, calls };
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

const TEMPLATE = {
  id: 'workflow-template-1',
  name: 'Notify owner on new work',
  triggerKind: 'work_item_created',
  actionKind: 'notify_owner',
  config: {},
  enabled: true,
  createdBy: 'user-1',
  createdAt: '2026-09-01T00:00:00.000Z',
};

describe('AutomationTemplateEditScreen', () => {
  it('prefills the form from the named template and is axe-clean', async () => {
    const { client } = clientOver(() => json(TEMPLATE));
    const { container } = render(
      withQuery(
        <AutomationTemplateEditScreen
          organizationSlug="acme"
          organizationName="Acme"
          templateId="workflow-template-1"
          client={client}
        />,
      ),
    );

    const nameField = await screen.findByRole('textbox', { name: /name/i });
    expect((nameField as HTMLInputElement).value).toBe('Notify owner on new work');
    await expectNoAxeViolations(container);
  });

  it('sends an edit as a PATCH to the template id', async () => {
    const { client, calls } = clientOver((call) => {
      expect(call.method).toBe('PATCH');
      return json({ ...TEMPLATE, name: 'Renamed' });
    });
    render(
      withQuery(
        <AutomationTemplateEditScreen
          organizationSlug="acme"
          organizationName="Acme"
          templateId="workflow-template-1"
          client={client}
        />,
      ),
    );

    const nameField = await screen.findByRole('textbox', { name: /name/i });
    const user = userEvent.setup();
    await user.clear(nameField);
    await user.type(nameField, 'Renamed');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH');
      expect(patch?.url).toContain('/automations/templates/workflow-template-1');
      expect(patch?.body).toContain('Renamed');
    });
  });

  it('shows a not-found state for an id the list does not contain', async () => {
    const { client } = clientOver(() => json(TEMPLATE));
    render(
      withQuery(
        <AutomationTemplateEditScreen
          organizationSlug="acme"
          organizationName="Acme"
          templateId="workflow-template-missing"
          client={client}
        />,
      ),
    );
    expect(await screen.findByText('Template not found')).toBeInTheDocument();
  });
});
