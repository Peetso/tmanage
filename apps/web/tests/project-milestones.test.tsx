import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProjectMilestonesScreen } from '../src/components/screens/ProjectMilestonesScreen';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * A9 — the project Milestones list and Edit milestone (Figma `fq6-milestones`,
 * `fq6-edit-milestone`). The API's tenant scoping, the owner check and the linked-milestone refusal
 * are proved beside the controller; this file proves what the screen draws and sends.
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

const PROJECT = 'project-1';
const NOW = '2026-10-20T12:00:00.000Z';

const milestones = [
  {
    id: 'm-1',
    projectId: PROJECT,
    title: 'Discovery',
    description: null,
    dueOn: '2026-10-10',
    status: 'met',
    published: true,
    ownerUserId: null,
    updatedAt: '2026-10-17T09:00:00.000Z',
  },
  {
    id: 'm-2',
    projectId: PROJECT,
    title: 'Design sign-off',
    description: 'Approved homepage, menu and booking page designs',
    dueOn: '2026-11-14',
    status: 'planned',
    published: true,
    ownerUserId: 'user-mona',
    updatedAt: NOW,
  },
  {
    id: 'm-3',
    projectId: PROJECT,
    title: 'Build and content',
    description: null,
    dueOn: '2026-12-05',
    status: 'planned',
    published: false,
    ownerUserId: null,
    updatedAt: NOW,
  },
];

const members = [
  { userId: 'user-mona', displayName: 'Mona Saleh', role: 'member', status: 'active' },
  { userId: 'user-karim', displayName: 'Karim Adel', role: 'manager', status: 'active' },
];

function mount(extra?: (call: Call) => Response | Promise<Response> | undefined) {
  const calls: Call[] = [];
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
      return Promise.resolve(extra?.(call) ?? route(call));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queries}>
      <ProjectMilestonesScreen
        organizationSlug="acme"
        organizationName="Northstar Studio"
        projectId={PROJECT}
        client={api}
      />
    </QueryClientProvider>,
  );
  return { calls, view };
}

function route(call: Call): Response {
  const { url, method } = call;
  if (url.includes('/milestone-plan')) {
    return json({ clientName: 'Atlas Hospitality', milestones });
  }
  if (url.includes('/milestones/') && method === 'PATCH') return json({});
  if (url.includes('/milestones/') && method === 'DELETE') {
    return new Response(null, { status: 204 });
  }
  if (url.includes('/members')) return json({ members, nextAfter: null });
  if (url.includes(`/projects/${PROJECT}`)) {
    return json({
      id: PROJECT,
      workspaceId: 'ws-1',
      name: 'Website relaunch',
      status: 'active',
      ownerUserId: null,
      committedAt: null,
      forecastAt: null,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
    });
  }
  return json({});
}

function rowOf(name: string): HTMLElement {
  return screen.getByText(name).closest('li') as HTMLElement;
}

describe('ProjectMilestonesScreen', () => {
  it('draws each milestone with its date, client chip and state pill', async () => {
    const { view } = mount();
    await screen.findByText('Discovery');

    const discovery = rowOf('Discovery');
    expect(within(discovery).getByText('Done on Sat 17 Oct')).toBeTruthy();
    expect(within(discovery).getByText('Client can see')).toBeTruthy();
    expect(within(discovery).getByText('Done')).toBeTruthy();

    const design = rowOf('Design sign-off');
    expect(within(design).getByText('Due Sat 14 Nov')).toBeTruthy();
    expect(within(design).getByText('In progress')).toBeTruthy();

    const build = rowOf('Build and content');
    expect(within(build).getByText('Next')).toBeTruthy();
    expect(within(build).queryByText('Client can see')).toBeNull();

    expect(await screen.findByText('Website relaunch', { selector: 'p' })).toBeTruthy();
    await expectNoAxeViolations(view.container);
  });

  it('a new milestone waits for the plan, then starts on the client timeline', async () => {
    let answerPlan: () => void = () => undefined;
    mount((call) =>
      call.url.includes('/milestone-plan')
        ? new Promise<Response>((resolve) => (answerPlan = () => resolve(route(call))))
        : undefined,
    );
    const add = screen.getByRole<HTMLButtonElement>('button', { name: 'Add milestone' });
    expect(add.disabled).toBe(true);
    answerPlan();
    await waitFor(() => expect(add.disabled).toBe(false));

    fireEvent.click(add);
    const dialog = await screen.findByRole('dialog', { name: 'Add milestone' });
    const shown = within(dialog).getByRole<HTMLInputElement>('switch', {
      name: 'Show on the client timeline',
    });
    expect(shown.checked).toBe(true);
  });

  it('saves an edit: owner, delivered text and hiding it from the client timeline', async () => {
    const { calls } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Design sign-off' }));

    const dialog = await screen.findByRole('dialog', { name: 'Edit milestone' });
    expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe(
      'Design sign-off',
    );
    expect(within(dialog).getByText('Atlas Hospitality sees the name and date.')).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText('Owner'), { target: { value: 'user-karim' } });
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Show on the client timeline' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    const patch = calls.find((call) => call.method === 'PATCH');
    expect(patch?.url).toMatch(/\/projects\/project-1\/milestones\/m-2$/);
    expect(JSON.parse(patch?.body ?? '{}')).toEqual({
      title: 'Design sign-off',
      dueOn: '2026-11-14',
      published: false,
      description: 'Approved homepage, menu and booking page designs',
      ownerUserId: 'user-karim',
    });
  });

  it('deletes a milestone, and explains a refusal when it is still linked', async () => {
    const { calls } = mount((call) =>
      call.method === 'DELETE'
        ? json({ error: { code: 'conflict', message: 'linked', requestId: 'r' } }, 409)
        : undefined,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Build and content' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit milestone' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete milestone' }));

    expect(
      await within(dialog).findByText(
        'This milestone is linked to other work, so it can’t be deleted.',
      ),
    ).toBeTruthy();
    const del = calls.find((call) => call.method === 'DELETE');
    expect(del?.url).toMatch(/\/projects\/project-1\/milestones\/m-3$/);
  });
});
