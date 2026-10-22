import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { WorkItemDetailScreen } from '../src/components/screens/WorkItemDetailScreen';
import { ApiClient } from '../src/lib/api/client';
import { translate, type MessageKey } from '../src/lib/i18n/t';

/**
 * P9 — the work item detail's owner and date chips, inline edit and delete. What the API does
 * with the PATCH and the DELETE is the API's suite; this proves what the screen sends and what
 * it does with the answer. Labels are read through `translate`, so the file holds whether or
 * not the wave's i18n fragment has been merged yet.
 */
const L = (key: string) => translate('en-US', key as MessageKey);

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
  title: 'Draft the homepage copy',
  state: 'in_progress',
  ownerUserId: 'user-1',
  audience: 'internal',
  startAt: null,
  dueAt: '2026-09-10T17:00:00.000Z',
  completedAt: null,
  version: 3,
  createdAt: '2026-08-26T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:00.000Z',
  deletedAt: null,
};

const MEMBERS = {
  members: [
    { userId: 'user-1', displayName: 'Ada Okonkwo', role: 'member', status: 'active' },
    { userId: 'user-omar', displayName: 'Omar Haddad', role: 'manager', status: 'active' },
  ],
  nextAfter: null,
};

function renderDetail(write: (call: Call) => Response, onDeleted = vi.fn()) {
  const calls: Call[] = [];
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
      if (call.url.includes('/members')) return Promise.resolve(json(MEMBERS));
      if (call.method !== 'GET') return Promise.resolve(write(call));
      if (call.url.endsWith('/work-items/wi-1')) return Promise.resolve(json(ITEM));
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
      />
    </QueryClientProvider>,
  );
  return { calls, onDeleted };
}

const startsWith = (prefix: string) => (name: string) => name.startsWith(prefix);
const includes = (part: string) => (name: string) => name.includes(part);

describe('P9 work item detail: owner, dates, edit, delete', () => {
  it('changes the owner by name and sends ownerUserId with the version read', async () => {
    const { calls } = renderDetail(() => json({ ...ITEM, ownerUserId: 'user-omar', version: 4 }));
    await userEvent.click(
      await screen.findByRole('button', { name: includes(L('WorkItemEdit.changeOwner')) }),
    );
    const picker = screen.getByRole('combobox', { name: L('WorkItemEdit.ownerLabel') });
    await userEvent.clear(picker);
    await userEvent.type(picker, 'Omar');
    await userEvent.click(await screen.findByRole('option', { name: /Omar Haddad/ }));
    await waitFor(() => {
      const patch = calls.find((call) => call.method === 'PATCH');
      expect(patch?.url).toContain('/work-items/wi-1');
      expect(patch?.body).toEqual({ ownerUserId: 'user-omar', version: 3 });
    });
  });

  it('sends the picked due date as dueAt', async () => {
    const { calls } = renderDetail(() => json({ ...ITEM, version: 4 }));
    await userEvent.click(
      await screen.findByRole('button', { name: startsWith(L('WorkItemEdit.changeDue')) }),
    );
    const due = screen.getByLabelText(L('WorkItemEdit.dueLabel'));
    await userEvent.clear(due);
    await userEvent.type(due, '2026-09-20');
    await userEvent.click(screen.getByRole('button', { name: L('WorkItemEdit.saveDates') }));
    await waitFor(() => {
      const patch = calls.find((call) => call.method === 'PATCH');
      expect(patch?.body).toEqual({
        startAt: null,
        dueAt: '2026-09-20T12:00:00.000Z',
        version: 3,
      });
    });
  });

  it('deletes after confirmation and hands back to the list', async () => {
    const { calls, onDeleted } = renderDetail(() => new Response(null, { status: 204 }));
    await userEvent.click(await screen.findByRole('button', { name: L('WorkItemEdit.delete') }));
    await userEvent.click(screen.getByRole('button', { name: L('WorkItemEdit.confirmDelete') }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    const deleted = calls.find((call) => call.method === 'DELETE');
    expect(deleted?.url).toMatch(/\/work-items\/wi-1$/);
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
    await userEvent.click(await screen.findByRole('button', { name: L('WorkItemEdit.edit') }));
    const title = screen.getByLabelText(new RegExp(L('WorkItemEdit.titleLabel')));
    await userEvent.clear(title);
    await userEvent.type(title, 'New title');
    await userEvent.click(screen.getByRole('button', { name: L('WorkItemEdit.save') }));
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
