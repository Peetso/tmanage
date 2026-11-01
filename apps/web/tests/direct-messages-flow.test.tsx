import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { NewMessageDialog } from '../src/components/chat/NewMessageDialog';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * A4 — direct messages: the sidebar's DIRECT MESSAGES rows (unread pill, Client chip), the
 * d-conversation screen (marks read on open, live refetch on the DM id, a retried send keeps one
 * `clientGeneratedId`) and d-new-message (a refused pair is said as the rule).
 */

interface Call {
  readonly url: string;
  readonly method: string | undefined;
  readonly body: unknown;
}

type Handler = (call: Call) => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clientOver(handler: Handler) {
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
      return Promise.resolve(handler(call));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => `id-${calls.length}`,
  });
  return { client, calls };
}

function wrap(children: ReactNode) {
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={queries}>{children}</QueryClientProvider>;
}

function dm(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dm-lina',
    otherUserId: 'user-lina',
    otherDisplayName: 'Lina Samir',
    lastMessageAt: null,
    createdAt: '2026-10-23T08:00:00.000Z',
    lastSequenceNo: 0,
    lastReadSequenceNo: 0,
    unreadCount: 0,
    ...overrides,
  };
}

const DIRECTORY = {
  channels: [
    {
      id: 'conv-1',
      projectId: 'proj-1',
      name: 'atlas-relaunch',
      createdByUserId: 'user-omar',
      version: 1,
      createdAt: '2026-10-23T00:00:00.000Z',
      updatedAt: '2026-10-23T00:00:00.000Z',
      archivedAt: null,
      lastActivityAt: '2026-10-23T00:00:00.000Z',
      memberCount: 3,
      clientMemberCount: 1,
      joined: true,
      memberPreview: [
        { userId: 'user-lina', displayName: 'Lina Samir', isClient: false },
        { userId: 'user-youssef', displayName: 'Youssef Kamal', isClient: true },
      ],
    },
  ],
};

const PROJECTS = { projects: [{ id: 'proj-1', name: 'Atlas relaunch' }] };

describe('New message', () => {
  it('leaves the signed-in person out of both lists (C5)', async () => {
    const user = userEvent.setup();
    const { client } = clientOver((call) => {
      if (call.url.includes('/direct-conversations')) {
        return json({ conversations: [], viewerUserId: 'user-me' });
      }
      if (call.url.includes('/members')) {
        return json({
          members: [
            { userId: 'user-me', displayName: 'Yara Me', role: 'owner', status: 'active' },
            { userId: 'user-yomna', displayName: 'Yomna Adel', role: 'member', status: 'active' },
          ],
          nextAfter: null,
        });
      }
      return json({}, 404);
    });
    render(
      wrap(
        <NewMessageDialog
          api={client}
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          onClose={() => {}}
          onOpened={() => {}}
        />,
      ),
    );

    const dialog = screen.getByRole('dialog', { name: 'New message' });
    await user.type(within(dialog).getByLabelText('To'), 'Y');
    expect(await within(dialog).findByRole('button', { name: /Yomna Adel/ })).toBeInTheDocument();
    await waitFor(() =>
      expect(within(dialog).queryByRole('button', { name: /Yara Me/ })).not.toBeInTheDocument(),
    );
  });

  it('says that nobody matched instead of showing an empty list (2026-10-31 live-test fix)', async () => {
    const user = userEvent.setup();
    const { client } = clientOver((call) => {
      if (call.url.includes('/members')) return json({ members: [], nextAfter: null });
      if (call.url.includes('/conversations/directory')) return json(DIRECTORY);
      if (call.url.includes('/projects')) return json(PROJECTS);
      return json({}, 404);
    });
    render(
      wrap(
        <NewMessageDialog
          api={client}
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          onClose={() => {}}
          onOpened={() => {}}
        />,
      ),
    );

    const dialog = screen.getByRole('dialog', { name: 'New message' });
    await user.type(within(dialog).getByLabelText('To'), 'Pe');
    expect(await within(dialog).findByText('No one matches “Pe”')).toBeInTheDocument();
    expect(
      within(dialog).getByText('Check the spelling, or invite them to this workspace first.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Open conversation' })).toBeDisabled();
  });

  it('lists your team and clients, and says the rule when a pair is refused', async () => {
    const user = userEvent.setup();
    const onOpened = vi.fn();
    const { client } = clientOver((call) => {
      if (call.method === 'POST' && call.url.includes('/direct-conversations')) {
        return json({ error: { code: 'not_found', message: 'Not found' } }, 404);
      }
      if (call.url.includes('/members')) {
        return json({
          members: [
            { userId: 'user-yomna', displayName: 'Yomna Adel', role: 'member', status: 'active' },
          ],
          nextAfter: null,
        });
      }
      if (call.url.includes('/conversations/directory')) return json(DIRECTORY);
      if (call.url.includes('/projects')) return json(PROJECTS);
      return json({}, 404);
    });
    render(
      wrap(
        <NewMessageDialog
          api={client}
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          onClose={() => {}}
          onOpened={onOpened}
        />,
      ),
    );

    const dialog = screen.getByRole('dialog', { name: 'New message' });
    await user.type(within(dialog).getByLabelText('To'), 'Y');
    expect(await within(dialog).findByText('Your team')).toBeInTheDocument();
    expect(within(dialog).getByText('Clients on projects you share')).toBeInTheDocument();
    // 2026-10-31 live-test fix: the route's sample company name is never printed; until the
    // session's organization list names the workspace, the subtitle is the role alone.
    expect(within(dialog).getByText('Member')).toBeInTheDocument();
    await expectNoAxeViolations(dialog);

    const youssef = await within(dialog).findByRole('button', { name: /Youssef Kamal/ });
    expect(within(youssef).getByText('Atlas relaunch')).toBeInTheDocument();
    expect(within(youssef).getByText('Client')).toBeInTheDocument();
    await user.click(youssef);
    expect(youssef).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(dialog).getByRole('button', { name: 'Open conversation' }));

    expect(await within(dialog).findByText('Could not open this conversation')).toBeInTheDocument();
    // The footnote states the rule; the refusal repeats it in the alert.
    expect(
      within(dialog).getAllByText('You can message a client only on a project you both work on.'),
    ).toHaveLength(2);
    expect(onOpened).not.toHaveBeenCalled();
  });

  it('opens (create-or-get) the conversation with the person picked', async () => {
    const user = userEvent.setup();
    const onOpened = vi.fn();
    const { client, calls } = clientOver((call) => {
      if (call.method === 'POST' && call.url.includes('/direct-conversations')) {
        return json(
          dm({ id: 'dm-yomna', otherUserId: 'user-yomna', otherDisplayName: 'Yomna Adel' }),
          201,
        );
      }
      if (call.url.includes('/members')) {
        return json({
          members: [
            { userId: 'user-yomna', displayName: 'Yomna Adel', role: 'member', status: 'active' },
          ],
          nextAfter: null,
        });
      }
      return json({}, 404);
    });
    render(
      wrap(
        <NewMessageDialog
          api={client}
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          onClose={() => {}}
          onOpened={onOpened}
        />,
      ),
    );

    await user.click(await screen.findByRole('button', { name: /Yomna Adel/ }));
    await user.click(screen.getByRole('button', { name: 'Open conversation' }));
    await waitFor(() =>
      expect(onOpened).toHaveBeenCalledWith(expect.objectContaining({ id: 'dm-yomna' })),
    );
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.body).toEqual({ userId: 'user-yomna' });
  });
});
