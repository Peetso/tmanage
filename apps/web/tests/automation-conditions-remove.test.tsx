import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { AutomationConditionsScreen } from '../src/components/screens/AutomationConditionsScreen';
import { AutomationTemplateEditScreen } from '../src/components/screens/AutomationTemplateEditScreen';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * L3 — a rule's conditions can be removed (Remove → confirm → DELETE → the list is read again),
 * and the "Skip weekends" hint says what the worker does: nothing is sent on Friday or Saturday.
 */

interface Call {
  readonly url: string;
  readonly method: string;
}

const TEMPLATE_ID = 'workflow-template-1';

const CONDITION = {
  id: 'c1',
  templateId: TEMPLATE_ID,
  field: 'status',
  op: 'neq',
  value: 'done',
  targetStep: 0,
  createdBy: 'user-1',
  createdAt: '2026-09-01T00:00:00.000Z',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clientOver(options: { deleteStatus?: number } = {}): {
  client: ApiClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  let removed = false;
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = { url: String(input), method: init?.method ?? 'GET' };
      calls.push(call);
      if (call.method === 'DELETE') {
        const status = options.deleteStatus ?? 204;
        if (status === 204) {
          removed = true;
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        return Promise.resolve(
          json({ error: { code: 'not_found', message: 'That condition is gone.' } }, status),
        );
      }
      if (call.url.includes('/conditions')) {
        return Promise.resolve(json({ conditions: removed ? [] : [CONDITION] }));
      }
      if (call.url.includes('/automations/runs')) return Promise.resolve(json({ runs: [] }));
      if (call.url.includes('/projects')) return Promise.resolve(json({ projects: [] }));
      return Promise.resolve(
        json({
          templates: [
            {
              id: TEMPLATE_ID,
              name: 'Due-date reminder',
              triggerKind: 'work_item_created',
              actionKind: 'notify_owner',
              config: { skipWeekends: true, alsoTell: 'none' },
              enabled: true,
              createdBy: 'user-1',
              createdAt: '2026-09-01T00:00:00.000Z',
            },
          ],
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
  return { client, calls };
}

function wrap(children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>);
}

function renderConditions(client: ApiClient) {
  return wrap(
    <AutomationConditionsScreen organizationSlug="acme" templateId={TEMPLATE_ID} client={client} />,
  );
}

describe('AutomationConditionsScreen — remove a condition', () => {
  it('asks first, then deletes the condition and reads the list again; axe-clean', async () => {
    const { client, calls } = clientOver();
    const { container } = renderConditions(client);
    const user = userEvent.setup();

    const remove = await screen.findByRole('button', { name: /^Remove status/ });
    await user.click(remove);

    expect(screen.getByRole('group', { name: 'Remove this condition?' })).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await expectNoAxeViolations(container);

    const listReadsBefore = calls.filter((c) => c.url.endsWith('/conditions')).length;
    await user.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      expect(screen.getByText('No conditions yet')).toBeInTheDocument();
    });
    const del = calls.find((c) => c.method === 'DELETE');
    expect(del?.url).toContain(`/automations/templates/${TEMPLATE_ID}/conditions/c1`);
    expect(calls.filter((c) => c.url.endsWith('/conditions')).length).toBeGreaterThan(
      listReadsBefore,
    );
    expect(screen.queryByRole('group', { name: 'Remove this condition?' })).toBeNull();
  });

  it('Keep it closes the question without deleting', async () => {
    const { client, calls } = clientOver();
    renderConditions(client);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /^Remove status/ }));
    await user.click(screen.getByRole('button', { name: 'Keep it' }));

    expect(screen.queryByRole('group', { name: 'Remove this condition?' })).toBeNull();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(screen.getByRole('cell', { name: 'done' })).toBeInTheDocument();
  });

  it('shows the refusal and keeps the row when the delete fails', async () => {
    const { client } = clientOver({ deleteStatus: 404 });
    renderConditions(client);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /^Remove status/ }));
    await user.click(screen.getByRole('button', { name: 'Remove' }));

    expect(await screen.findByText('Could not remove the condition')).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'done' })).toBeInTheDocument();
  });
});

describe('AutomationTemplateEditScreen — Skip weekends hint', () => {
  it('says no reminders are sent on Friday or Saturday', async () => {
    const { client } = clientOver();
    wrap(
      <AutomationTemplateEditScreen
        organizationSlug="acme"
        organizationName="Acme"
        templateId={TEMPLATE_ID}
        client={client}
      />,
    );
    expect(
      await screen.findByText('No reminders are sent on Friday or Saturday.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/go out on Thursday/)).toBeNull();
  });
});
