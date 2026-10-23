import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { AutomationTemplateEditScreen } from '../src/components/screens/AutomationTemplateEditScreen';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * Automation rule settings (A14, Figma fq11-automation-rule). The API's tenant scoping, the
 * `org.manage` gate and the 404-before-authorize order are proved in the controller unit tests;
 * this file proves what the *page* does: it prefills from the rule and its conditions, saves the
 * name, switches and options as one PATCH and a changed Project/Status as new conditions, shows
 * when the rule last ran, deletes after a confirm, and is axe-clean (A11Y-01).
 */

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: string | undefined;
}

const TEMPLATE = {
  id: 'workflow-template-1',
  name: 'Due-date reminder',
  triggerKind: 'work_item_created',
  actionKind: 'notify_owner',
  config: { skipWeekends: true, alsoTell: 'project_lead' },
  enabled: true,
  createdBy: 'user-1',
  createdAt: '2026-09-01T00:00:00.000Z',
};

const PROJECT = {
  id: 'project-1',
  workspaceId: 'workspace-1',
  name: 'Website relaunch',
  status: 'active',
  ownerUserId: null,
  committedAt: null,
};

function todayAt(hours: number): string {
  const date = new Date();
  date.setHours(hours, 0, 0, 0);
  return date.toISOString();
}

const RUNS = [
  {
    id: 'r1',
    templateId: TEMPLATE.id,
    status: 'succeeded',
    startedAt: todayAt(9),
    finishedAt: todayAt(9),
  },
  {
    id: 'r2',
    templateId: TEMPLATE.id,
    status: 'succeeded',
    startedAt: todayAt(8),
    finishedAt: todayAt(8),
  },
  {
    id: 'r3',
    templateId: TEMPLATE.id,
    status: 'succeeded',
    startedAt: todayAt(7),
    finishedAt: todayAt(7),
  },
  {
    id: 'r4',
    templateId: 'other',
    status: 'succeeded',
    startedAt: todayAt(9),
    finishedAt: todayAt(9),
  },
];

const CONDITIONS = [
  {
    id: 'c1',
    templateId: TEMPLATE.id,
    field: 'status',
    op: 'neq',
    value: 'done',
    targetStep: 0,
    createdBy: 'user-1',
    createdAt: '2026-09-01T00:00:00.000Z',
  },
];

function clientOver(write: (call: Call) => Response = () => json({})): {
  client: ApiClient;
  calls: Call[];
} {
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
      if (call.method !== 'GET') return Promise.resolve(write(call));
      if (call.url.includes('/conditions'))
        return Promise.resolve(json({ conditions: CONDITIONS }));
      if (call.url.includes('/automations/runs')) return Promise.resolve(json({ runs: RUNS }));
      if (call.url.includes('/projects')) return Promise.resolve(json({ projects: [PROJECT] }));
      return Promise.resolve(json({ templates: [TEMPLATE] }));
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

function renderScreen(client: ApiClient, templateId = TEMPLATE.id) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrap = (children: ReactNode) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(
    wrap(
      <AutomationTemplateEditScreen
        organizationSlug="acme"
        organizationName="Acme"
        templateId={templateId}
        client={client}
      />,
    ),
  );
}

describe('AutomationTemplateEditScreen (A14 rule settings)', () => {
  it('prefills the rule, its options, its conditions and when it last ran; axe-clean', async () => {
    const { client } = clientOver();
    const { container } = renderScreen(client);

    const nameField = await screen.findByRole('textbox', { name: 'Rule name' });
    expect((nameField as HTMLInputElement).value).toBe('Due-date reminder');
    expect(screen.getByRole('switch', { name: 'Skip weekends' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Rule is on' })).toBeChecked();
    expect((screen.getByRole('combobox', { name: 'Also tell' }) as HTMLSelectElement).value).toBe(
      'project_lead',
    );
    expect((screen.getByRole('combobox', { name: 'Status' }) as HTMLSelectElement).value).toBe(
      'not_done',
    );
    expect(
      await screen.findByText('Last ran today at 9:00 · 3 reminders sent.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Remind the owner when a work item is created' }),
    ).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('saves the toggles as one PATCH and a changed Project as a new condition', async () => {
    const { client, calls } = clientOver((call) =>
      call.method === 'PATCH' ? json(TEMPLATE) : json({ ...CONDITIONS[0], id: 'c2' }, 201),
    );
    renderScreen(client);
    const user = userEvent.setup();

    await screen.findByRole('textbox', { name: 'Rule name' });
    await screen.findByRole('option', { name: 'Website relaunch' });
    await user.click(screen.getByRole('switch', { name: 'Skip weekends' }));
    await user.click(screen.getByRole('switch', { name: 'Rule is on' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Project' }), 'project-1');
    await user.click(screen.getByRole('button', { name: 'Save rule' }));

    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/conditions'))).toBe(true);
    });
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.url).toContain('/automations/templates/workflow-template-1');
    expect(JSON.parse(patch?.body ?? '{}')).toMatchObject({
      enabled: false,
      config: { skipWeekends: false, alsoTell: 'project_lead' },
    });
    const posts = calls.filter((c) => c.method === 'POST');
    // Only the Project changed; the unchanged Status writes nothing.
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]?.body ?? '{}')).toEqual({
      field: 'project_id',
      op: 'eq',
      value: 'project-1',
      targetStep: 0,
    });
  });

  it('deletes the rule only after the confirm, then shows it is gone', async () => {
    const { client, calls } = clientOver(() => new Response(null, { status: 204 }));
    renderScreen(client);
    const user = userEvent.setup();

    await screen.findByRole('textbox', { name: 'Rule name' });
    await user.click(screen.getByRole('button', { name: 'Delete rule' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText('Rule deleted')).toBeInTheDocument();
    const deleted = calls.find((c) => c.method === 'DELETE');
    expect(deleted?.url).toContain('/automations/templates/workflow-template-1');
  });

  it('says the rule is running when the delete is refused with 409', async () => {
    const { client } = clientOver(() =>
      json({ error: { code: 'conflict', message: 'busy', correlationId: 'x' } }, 409),
    );
    renderScreen(client);
    const user = userEvent.setup();

    await screen.findByRole('textbox', { name: 'Rule name' });
    await user.click(screen.getByRole('button', { name: 'Delete rule' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(
      await screen.findByText('This rule is running right now. Try again in a moment.'),
    ).toBeInTheDocument();
  });

  it('shows a not-found state for an id the list does not contain', async () => {
    const { client } = clientOver();
    renderScreen(client, 'workflow-template-missing');
    expect(await screen.findByText('Template not found')).toBeInTheDocument();
  });
});
