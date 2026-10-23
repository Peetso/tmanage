import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { NewProjectFromTemplateDialog } from '../src/components/projects/NewProjectFromTemplateDialog';
import { ApiClient } from '../src/lib/api/client';
import type { ProjectSummary } from '../src/lib/api/projects';
import type { ProjectTemplateView } from '../src/lib/api/project-templates';
import { expectNoAxeViolations } from './axe';

/**
 * A9 — "New project from a template" (Figma `fq6-new-from-template`). The API copies the plan and
 * moves the dates (proved beside the templates controller); this file proves what the dialog draws
 * and what it sends.
 */

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: string | undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const NOW = '2026-10-20T12:00:00.000Z';

function template(partial: Partial<ProjectTemplateView>): ProjectTemplateView {
  return {
    id: 'tpl',
    name: 'Template',
    description: null,
    defaultObjectives: [],
    milestoneCount: 0,
    workItemCount: 0,
    clientPortalOn: false,
    repeatInterval: null,
    createdBy: 'user-1',
    createdAt: NOW,
    ...partial,
  };
}

const templates = [
  template({
    id: 'tpl-web',
    name: 'Website build',
    milestoneCount: 4,
    workItemCount: 18,
    clientPortalOn: true,
  }),
  template({ id: 'tpl-brand', name: 'Brand identity', milestoneCount: 3, workItemCount: 12 }),
  template({
    id: 'tpl-retainer',
    name: 'Monthly retainer',
    workItemCount: 6,
    repeatInterval: 'monthly',
  }),
];

const project = {
  id: 'project-new',
  workspaceId: 'ws-1',
  name: 'Atlas spa microsite',
  status: 'active',
  ownerUserId: null,
  committedAt: null,
  forecastAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
};

function mount() {
  const calls: Call[] = [];
  const created: ProjectSummary[] = [];
  const api = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : undefined,
      };
      calls.push(call);
      const { url, method } = call;
      if (url.includes('/workspaces'))
        return Promise.resolve(json({ workspaces: [{ id: 'ws-1' }] }));
      if (url.includes('/client-organization-options')) {
        return Promise.resolve(
          json({ clientOrganizations: [{ id: 'client-atlas', name: 'Atlas Hospitality' }] }),
        );
      }
      if (url.includes('/members')) {
        return Promise.resolve(
          json({
            members: [
              {
                userId: 'user-karim',
                displayName: 'Karim Adel',
                role: 'manager',
                status: 'active',
              },
            ],
            nextAfter: null,
          }),
        );
      }
      if (url.includes('/client') && method === 'PUT')
        return Promise.resolve(json({ clients: [] }));
      if (method === 'POST') return Promise.resolve(json(project, 201));
      return Promise.resolve(json({}));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queries}>
      <NewProjectFromTemplateDialog
        api={api}
        organizationSlug="acme"
        templates={templates}
        onClose={() => undefined}
        onCreated={(made) => created.push(made)}
      />
    </QueryClientProvider>,
  );
  return { calls, created, view };
}

describe('NewProjectFromTemplateDialog', () => {
  it('lists each template with its counts, plus the blank project', async () => {
    const { view } = mount();
    const dialog = screen.getByRole('dialog', { name: 'New project from a template' });
    expect(
      within(dialog).getByText('4 milestones · 18 work items · client portal on'),
    ).toBeTruthy();
    expect(within(dialog).getByText('3 milestones · 12 work items')).toBeTruthy();
    expect(within(dialog).getByText('Repeats every month · 6 work items')).toBeTruthy();
    expect(within(dialog).getByText('Start with nothing')).toBeTruthy();
    expect((within(dialog).getByLabelText(/Website build/) as HTMLInputElement).checked).toBe(true);
    await expectNoAxeViolations(view.container);
  });

  it('creates from the template with the start date, client and lead', async () => {
    const { calls, created } = mount();
    const dialog = screen.getByRole('dialog', { name: 'New project from a template' });
    await screen.findByRole('option', { name: 'Atlas Hospitality' });
    await screen.findByRole('option', { name: 'Karim Adel' });

    fireEvent.change(within(dialog).getByLabelText('Project name'), {
      target: { value: 'Atlas spa microsite' },
    });
    fireEvent.change(within(dialog).getByLabelText('Client'), {
      target: { value: 'client-atlas' },
    });
    fireEvent.change(within(dialog).getByLabelText('Start date'), {
      target: { value: '2026-11-03' },
    });
    fireEvent.change(within(dialog).getByLabelText('Lead'), { target: { value: 'user-karim' } });
    expect(within(dialog).getByText('Tue 3 Nov')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(created).toHaveLength(1));

    const post = calls.find((call) => call.method === 'POST');
    expect(post?.url).toMatch(/\/projects\/templates\/tpl-web\/instantiate$/);
    expect(JSON.parse(post?.body ?? '{}')).toEqual({
      workspaceId: 'ws-1',
      name: 'Atlas spa microsite',
      startDate: '2026-11-03',
      clientOrganizationId: 'client-atlas',
      leadUserId: 'user-karim',
    });
  });

  it('a blank project is a plain create, then shared with the chosen client', async () => {
    const { calls, created } = mount();
    const dialog = screen.getByRole('dialog', { name: 'New project from a template' });
    await screen.findByRole('option', { name: 'Atlas Hospitality' });

    fireEvent.click(within(dialog).getByLabelText(/Blank project/));
    fireEvent.change(within(dialog).getByLabelText('Project name'), {
      target: { value: 'Atlas spa microsite' },
    });
    fireEvent.change(within(dialog).getByLabelText('Client'), {
      target: { value: 'client-atlas' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(created).toHaveLength(1));

    expect(calls.find((call) => call.method === 'POST')?.url).toMatch(
      /\/organizations\/acme\/projects$/,
    );
    expect(calls.find((call) => call.method === 'PUT')?.url).toMatch(
      /\/projects\/project-new\/client$/,
    );
  });
});
