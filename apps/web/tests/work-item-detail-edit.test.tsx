import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { WorkItemDetailScreen } from '../src/components/screens/WorkItemDetailScreen';
import { ApiClient } from '../src/lib/api/client';
import { translate, type MessageKey } from '../src/lib/i18n/t';
import { undoQueue } from '../src/lib/undo/use-undo';

/**
 * A6 (on P9) — the work item detail's owner picker, date picker, edit dialog, actions menu and
 * delete confirm. What the API does with the PATCH, POST and DELETE is the API's suite; this
 * proves what the screen sends and what it does with the answer. Labels are read through
 * `translate`, so the file holds whether or not the wave's i18n fragment has been merged yet.
 */
const L = (key: string, vars: Record<string, string | number> = {}) => {
  let text = translate('en-US', key as MessageKey);
  for (const [name, value] of Object.entries(vars))
    text = text.split(`{${name}}`).join(String(value));
  return text;
};

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const ITEM = {
  id: 'wi-1',
  projectId: 'proj-1',
  type: 'task',
  title: 'Homepage hero copy',
  description: 'Write the hero headline.',
  state: 'in_progress',
  ownerUserId: 'user-1',
  audience: 'internal',
  startAt: null,
  dueAt: '2026-10-28T12:00:00.000Z',
  completedAt: null,
  version: 3,
  createdAt: '2026-10-20T00:00:00.000Z',
  updatedAt: '2026-10-22T00:00:00.000Z',
  deletedAt: null,
};

const MEMBERS = {
  members: [
    { userId: 'user-1', displayName: 'Mona Saleh', role: 'member', status: 'active' },
    { userId: 'user-omar', displayName: 'Omar Nabil', role: 'manager', status: 'active' },
  ],
  nextAfter: null,
};

const PROJECTS = {
  projects: [
    { id: 'proj-1', name: 'Website relaunch' },
    { id: 'proj-2', name: 'Brand refresh' },
  ],
};

function renderDetail(
  write: (call: Call) => Response,
  item: Record<string, unknown> = ITEM,
  onDeleted = vi.fn(),
) {
  const calls: Call[] = [];
  const onOpenItem = vi.fn();
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      };
      calls.push(call);
      const path = call.url.replace('https://api.example.test', '').split('?')[0] ?? '';
      if (call.method !== 'GET') return Promise.resolve(write(call));
      if (path.endsWith('/projects/proj-1/members') || path.endsWith('/projects/proj-2/members')) {
        return Promise.resolve(
          json({
            members: [
              { projectMembershipId: 'pm-1', userId: 'user-1', role: 'member', createdAt: '' },
              { projectMembershipId: 'pm-2', userId: 'user-omar', role: 'lead', createdAt: '' },
            ],
          }),
        );
      }
      if (path.endsWith('/members')) return Promise.resolve(json(MEMBERS));
      if (path.endsWith('/projects')) return Promise.resolve(json(PROJECTS));
      if (path.endsWith('/work-items/wi-1')) return Promise.resolve(json(item));
      if (path.endsWith('/files')) {
        return Promise.resolve(
          json({
            files: [
              {
                id: 'link-1',
                workItemId: 'wi-1',
                fileAssetId: 'asset-1',
                fileName: 'hero-copy.docx',
                availability: 'ready',
                attachedByMembershipId: 'm-1',
                createdAt: '2026-10-22T10:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path.endsWith('/activity')) return Promise.resolve(json({ activity: [] }));
      if (path.endsWith('/checklist')) return Promise.resolve(json({ items: [] }));
      if (path.endsWith('/projects/proj-1/clients')) {
        return Promise.resolve(
          json({
            clients: [
              { id: 's-1', projectId: 'proj-1', clientOrganizationId: 'c-1', createdAt: '' },
            ],
          }),
        );
      }
      if (path.endsWith('/client-organization-options')) {
        return Promise.resolve(
          json({ clientOrganizations: [{ id: 'c-1', name: 'Atlas Hospitality' }] }),
        );
      }
      if (path.endsWith('/deliverables')) return Promise.resolve(json({ deliverables: [] }));
      return Promise.resolve(json({}, 404));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queries}>
      <WorkItemDetailScreen
        organizationSlug="northstar"
        organizationName="Northstar Studio"
        workItemId="wi-1"
        client={client}
        onDeleted={onDeleted}
        onOpenItem={onOpenItem}
        now={new Date(2026, 9, 23, 9, 0, 0)}
      />
    </QueryClientProvider>,
  );
  return { calls, onDeleted, onOpenItem };
}

const patches = (calls: readonly Call[]) => calls.filter((call) => call.method === 'PATCH');

describe('A6 work item detail', () => {
  it('assigns an owner from the project-only picker with the version read', async () => {
    const { calls } = renderDetail(() => json({ ...ITEM, ownerUserId: 'user-omar', version: 4 }));
    await userEvent.click(
      await screen.findByRole('button', {
        name: new RegExp(`^${L('WorkDetail.owner')}\\s*Mona Saleh$`),
      }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(L('OwnerPicker.onlyProject', { project: 'Website relaunch' })),
    ).toBeInTheDocument();
    await userEvent.click(await within(dialog).findByRole('button', { name: /Omar Nabil/ }));
    await userEvent.click(
      within(dialog).getByRole('button', { name: L('OwnerPicker.assign', { name: 'Omar' }) }),
    );
    await waitFor(() =>
      expect(patches(calls)[0]?.body).toEqual({ ownerUserId: 'user-omar', version: 3 }),
    );
  });

  it('sets the due date from the picker as noon UTC of the picked day', async () => {
    const { calls } = renderDetail(() => json({ ...ITEM, version: 4 }));
    await userEvent.click(
      await screen.findByRole('button', {
        name: new RegExp(`^${L('WorkDetail.due')}\\s*Wed 28 Oct$`),
      }),
    );
    const picker = await screen.findByTestId('due-date-picker');
    await userEvent.click(
      within(picker).getByRole('button', { name: new RegExp(`^${L('DueDatePicker.tomorrow')}`) }),
    );
    await waitFor(() =>
      expect(patches(calls)[0]?.body).toEqual({ dueAt: '2026-10-24T12:00:00.000Z', version: 3 }),
    );
  });

  it('saves a new description from the edit dialog', async () => {
    const { calls } = renderDetail(() => json({ ...ITEM, description: 'Under 12 words.' }));
    await userEvent.click(await screen.findByRole('button', { name: L('WorkDetail.edit') }));
    const dialog = await screen.findByRole('dialog');
    const description = within(dialog).getByLabelText(L('EditWorkItem.descriptionLabel'));
    await userEvent.clear(description);
    await userEvent.type(description, 'Under 12 words.');
    await userEvent.click(within(dialog).getByRole('button', { name: L('EditWorkItem.save') }));
    await waitFor(() =>
      expect(patches(calls)[0]?.body).toEqual({ description: 'Under 12 words.', version: 3 }),
    );
  });

  it('moves the item to another project with projectId', async () => {
    const { calls } = renderDetail(() => json({ ...ITEM, projectId: 'proj-2', version: 4 }));
    await userEvent.click(
      await screen.findByRole('button', {
        name: L('WorkActions.trigger', { title: ITEM.title }),
      }),
    );
    await userEvent.click(screen.getByRole('menuitem', { name: L('WorkActions.move') }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.selectOptions(
      within(dialog).getByRole('combobox', { name: L('EditWorkItem.project') }),
      'proj-2',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: L('EditWorkItem.save') }));
    await waitFor(() =>
      expect(patches(calls)[0]?.body).toEqual({ projectId: 'proj-2', version: 3 }),
    );
  });

  it('duplicates as a "Copy of" item and opens the copy', async () => {
    const { calls, onOpenItem } = renderDetail(() =>
      json({ ...ITEM, id: 'wi-2', title: 'copy', version: 1 }, 201),
    );
    await userEvent.click(
      await screen.findByRole('button', {
        name: L('WorkActions.trigger', { title: ITEM.title }),
      }),
    );
    await userEvent.click(screen.getByRole('menuitem', { name: L('WorkActions.duplicate') }));
    await waitFor(() => expect(onOpenItem).toHaveBeenCalledWith('wi-2'));
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.url).toMatch(/\/work-items$/);
    expect(post?.body).toEqual({
      projectId: 'proj-1',
      title: L('WorkDetail.copyOf', { title: ITEM.title }),
      type: 'task',
      audience: 'internal',
      ownerUserId: 'user-1',
      dueAt: ITEM.dueAt,
      description: ITEM.description,
    });
  });

  it('shows the client note on delete only for a client-visible item', async () => {
    const { calls, onDeleted } = renderDetail(() => new Response(null, { status: 204 }), {
      ...ITEM,
      audience: 'client_visible',
    });
    await userEvent.click(await screen.findByRole('button', { name: L('WorkDetail.delete') }));
    const dialog = await screen.findByRole('dialog');
    expect(
      await within(dialog).findByText(
        L('DeleteWorkItem.clientNote', { client: 'Atlas Hospitality' }),
      ),
    ).toBeInTheDocument();
    await userEvent.click(
      within(dialog).getByRole('button', { name: L('DeleteWorkItem.confirm') }),
    );
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    // 55-23: the DELETE is held behind the Undo toast; nothing is sent until the hold ends.
    expect(calls.find((call) => call.method === 'DELETE')).toBeUndefined();
    undoQueue.flushAll();
    await waitFor(() =>
      expect(calls.find((call) => call.method === 'DELETE')?.url).toMatch(/\/work-items\/wi-1$/),
    );
  });

  it('has no client note when deleting an internal item', async () => {
    renderDetail(() => new Response(null, { status: 204 }));
    await userEvent.click(await screen.findByRole('button', { name: L('WorkDetail.delete') }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('note')).toBeNull();
  });

  it('shows the conflict message and reloads on a version 409', async () => {
    const { calls } = renderDetail(() =>
      json(
        {
          error: {
            code: 'conflict',
            message: 'stale',
            correlationId: 'correlation-fixed',
            details: [{ field: 'version', message: 'is stale' }],
          },
        },
        409,
      ),
    );
    await userEvent.click(await screen.findByRole('button', { name: L('WorkDetail.edit') }));
    const dialog = await screen.findByRole('dialog');
    const title = within(dialog).getByLabelText(new RegExp(L('EditWorkItem.titleLabel')));
    await userEvent.clear(title);
    await userEvent.type(title, 'New title');
    await userEvent.click(within(dialog).getByRole('button', { name: L('EditWorkItem.save') }));
    expect(
      await screen.findByText(translate('en-US', 'WorkItemDetailScreen.conflictTitle')),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        calls.filter((call) => call.method === 'GET' && call.url.endsWith('/wi-1')),
      ).toHaveLength(2),
    );
  });
});
