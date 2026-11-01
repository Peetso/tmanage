import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import {
  decodeMentions,
  encodeMentions,
  findMentionQuery,
} from '../src/components/chat/MentionPicker';
import { ProjectChannelScreen } from '../src/components/screens/ProjectChannelScreen';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * A4 — m-mention: the @ picker over the channel composer. It opens on `@`, groups people into
 * PROJECT MEMBERS and OTHERS WHO CAN SEE THIS CHANNEL, Enter inserts the name, the send carries
 * the API's `@<userId>` token, and Esc closes it.
 */

interface Call {
  readonly url: string;
  readonly method: string | undefined;
  readonly body: unknown;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const CONVERSATION = {
  id: 'conv-1',
  projectId: 'proj-1',
  name: 'atlas-relaunch',
  createdByUserId: 'user-omar',
  version: 1,
  createdAt: '2026-10-23T00:00:00.000Z',
  updatedAt: '2026-10-23T00:00:00.000Z',
  archivedAt: null,
};

const CANDIDATES = [
  { userId: 'user-lina', displayName: 'Lina Samir', mention: '@user-lina' },
  { userId: 'user-lisa', displayName: 'Lisa Karam', mention: '@user-lisa' },
  { userId: 'user-lian', displayName: 'Lian Fawzy', mention: '@user-lian' },
];

function setup(candidates: readonly unknown[] = CANDIDATES) {
  const calls: Call[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        method: init?.method,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      };
      calls.push(call);
      const url = call.url;
      if (url.includes('/mention-candidates')) return Promise.resolve(json({ candidates }));
      if (url.includes('/projects/proj-1/members')) {
        return Promise.resolve(
          json({
            members: [
              { projectMembershipId: 'pm-1', userId: 'user-lina', role: 'member', createdAt: '' },
              { projectMembershipId: 'pm-2', userId: 'user-lian', role: 'member', createdAt: '' },
            ],
          }),
        );
      }
      if (url.includes('/messages')) {
        if (call.method === 'POST') {
          return Promise.resolve(
            json(
              {
                id: 'msg-new',
                conversationId: 'conv-1',
                authorUserId: 'user-omar',
                sequenceNo: 1,
                parentMessageId: null,
                body: 'x',
                bodyRich: null,
                editedAt: null,
                deletedAt: null,
                deletedByUserId: null,
                createdAt: '2026-10-23T11:02:00.000Z',
              },
              201,
            ),
          );
        }
        return Promise.resolve(json({ messages: [] }));
      }
      if (url.includes('/realtime/tickets')) {
        return Promise.resolve(json({ ticket: 't', expiresAt: '', socketUrl: null }, 201));
      }
      if (url.includes('/conversations/conv-1')) return Promise.resolve(json(CONVERSATION));
      if (url.includes('/projects/proj-1')) {
        return Promise.resolve(json({ id: 'proj-1', name: 'Atlas relaunch' }));
      }
      return Promise.resolve(json({}, 404));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrap = (children: ReactNode) => (
    <QueryClientProvider client={queries}>{children}</QueryClientProvider>
  );
  render(
    wrap(
      <ProjectChannelScreen
        organizationSlug="northstar"
        organizationName="Northstar Studio"
        conversationId="conv-1"
        client={client}
      />,
    ),
  );
  return { calls };
}

describe('the @ picker', () => {
  it('opens on @ with the two groups and the key hint', async () => {
    const user = userEvent.setup();
    setup();
    const box = await screen.findByLabelText('Message the channel');
    await user.type(box, 'Can you take the mobile flow, @Li');

    const listbox = await screen.findByRole('listbox', { name: 'People to mention' });
    const project = within(listbox).getByRole('group', { name: 'Project members' });
    const others = within(listbox).getByRole('group', { name: 'Others who can see this channel' });
    expect(
      within(project)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual([expect.stringContaining('Lina Samir'), expect.stringContaining('Lian Fawzy')]);
    expect(within(others).getByRole('option')).toHaveTextContent('Lisa Karam');
    expect(within(project).getAllByRole('option')[0]).toHaveTextContent('Atlas relaunch');
    expect(screen.getByText('↑↓ to move · Enter to mention · Esc to close')).toBeInTheDocument();
    expect(within(project).getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
    await expectNoAxeViolations(listbox.parentElement as HTMLElement);
  });

  it('Enter inserts the name, and the send carries the mention token', async () => {
    const user = userEvent.setup();
    const { calls } = setup();
    const box = await screen.findByLabelText('Message the channel');
    await user.type(box, 'Can you take the mobile flow, @Li');
    await screen.findByRole('listbox', { name: 'People to mention' });

    await user.keyboard('{ArrowDown}{Enter}');
    expect(box).toHaveValue('Can you take the mobile flow, @Lian Fawzy ');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST' && c.url.includes('/messages'))).toBeDefined(),
    );
    const post = calls.find((c) => c.method === 'POST' && c.url.includes('/messages'));
    expect((post?.body as { body: string }).body).toBe('Can you take the mobile flow, @user-lian');
  });

  it('Esc closes it without sending, and the round @ button opens it again', async () => {
    const user = userEvent.setup();
    const { calls } = setup();
    const box = await screen.findByLabelText('Message the channel');
    await user.type(box, '@L');
    await screen.findByRole('listbox', { name: 'People to mention' });

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(box).toHaveValue('@L');
    await user.type(box, 'i');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/messages'))).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Mention someone' }));
    expect(await screen.findByRole('listbox', { name: 'People to mention' })).toBeInTheDocument();
    expect(box).toHaveValue('@Li @');
  });
});

describe('the @ picker when nobody matches (2026-10-31 live-test fix)', () => {
  it('a bare @ with nobody to mention says so instead of not opening', async () => {
    const user = userEvent.setup();
    setup([]);
    await screen.findByLabelText('Message the channel');
    await user.click(screen.getByRole('button', { name: 'Mention someone' }));
    const status = (await screen.findByTestId('mention-picker')).querySelector('[role="status"]');
    expect(status).toHaveTextContent('No one to mention yet');
    expect(status).toHaveTextContent('Invite teammates from People to mention them.');
    expect(screen.getByText('Esc to close')).toBeInTheDocument();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('@ with letters that match nobody names the letters, and Esc closes it', async () => {
    const user = userEvent.setup();
    setup([]);
    const box = await screen.findByLabelText('Message the channel');
    await user.type(box, 'QA @Pe');
    expect(await screen.findByText('No one matches “Pe”')).toBeInTheDocument();
    expect(box).not.toHaveAttribute('aria-activedescendant');
    await user.keyboard('{Escape}');
    expect(screen.queryByText('No one matches “Pe”')).not.toBeInTheDocument();
    expect(box).toHaveValue('QA @Pe');
  });
});

describe('the channel draft after a send (2026-10-31 live-test fix)', () => {
  it('clears the stored draft once, not twice', async () => {
    const user = userEvent.setup();
    const { calls } = setup();
    const box = await screen.findByLabelText('Message the channel');
    await user.type(box, 'Hello team');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(box).toHaveValue(''));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const deletes = calls.filter((c) => c.method === 'DELETE' && c.url.endsWith('/draft'));
    expect(deletes).toHaveLength(1);
  });
});

describe('mention text helpers', () => {
  it('finds the open @word only at the start of a word', () => {
    expect(findMentionQuery('hi @Li', 6)).toEqual({ start: 3, query: 'Li' });
    expect(findMentionQuery('mail@x', 6)).toBeNull();
    expect(findMentionQuery('@Li done', 8)).toBeNull();
  });

  it('encodes picked names to tokens and decodes tokens to names', () => {
    const picked = new Map([
      ['Lina Samir', '@user-lina'],
      ['Lina', '@user-other'],
    ]);
    expect(encodeMentions('ok @Lina Samir and @Lina', picked)).toBe(
      'ok @user-lina and @user-other',
    );
    expect(
      decodeMentions('Yes. @user-maya can you confirm', (id) =>
        id === 'user-maya' ? 'Maya Hassan' : undefined,
      ),
    ).toBe('Yes. @Maya Hassan can you confirm');
  });
});
