import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ChatSidebar } from '../src/components/chat/ChatSidebar';
import { NewMessageDialog } from '../src/components/chat/NewMessageDialog';
import { DirectMessageScreen } from '../src/components/screens/DirectMessageScreen';
import { ApiClient } from '../src/lib/api/client';
import type { LiveSocket } from '../src/lib/use-channel-live-feed';
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

function todayAt(hours: number, minutes: number): string {
  const at = new Date();
  at.setHours(hours, minutes, 0, 0);
  return at.toISOString();
}

function message(sequenceNo: number, authorUserId: string, body: string, minute = 12) {
  return {
    id: `m-${sequenceNo}`,
    directConversationId: 'dm-lina',
    authorUserId,
    sequenceNo,
    body,
    createdAt: todayAt(9, minute),
  };
}

describe('the DIRECT MESSAGES list', () => {
  it('shows the unread pill, the Client chip, and the project channels', async () => {
    const { client } = clientOver((call) => {
      if (call.url.includes('/direct-conversations')) {
        return json({
          conversations: [
            dm({
              id: 'dm-omar',
              otherUserId: 'user-omar',
              otherDisplayName: 'Omar Adel',
              unreadCount: 2,
            }),
            dm({
              id: 'dm-youssef',
              otherUserId: 'user-youssef',
              otherDisplayName: 'Youssef Kamal',
            }),
          ],
        });
      }
      if (call.url.includes('/conversations/directory')) return json(DIRECTORY);
      if (call.url.includes('/projects')) return json(PROJECTS);
      return json({}, 404);
    });

    const { container } = render(
      wrap(
        <ChatSidebar
          api={client}
          organizationSlug="northstar"
          organizationName="Northstar Studio"
        />,
      ),
    );

    const omar = await screen.findByRole('link', { name: /Omar Adel/ });
    expect(omar).toHaveAttribute('href', '/northstar/chat/dm/dm-omar');
    expect(within(omar).getByText('2')).toBeInTheDocument();
    expect(omar).toHaveAccessibleName(expect.stringContaining('2 unread messages'));

    const youssef = await screen.findByRole('link', { name: /Youssef Kamal/ });
    expect(await within(youssef).findByText('Client')).toBeInTheDocument();
    expect(within(youssef).queryByText('2')).not.toBeInTheDocument();

    expect(
      await screen.findByRole('link', { name: '#atlas-relaunch, Atlas relaunch' }),
    ).toHaveAttribute('href', '/northstar/chat/conv-1');
    expect(screen.getByRole('button', { name: 'New message' })).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });
});

describe('a direct conversation', () => {
  function dmHandler(overrides: { post?: Handler; messages?: Handler } = {}): Handler {
    return (call) => {
      if (call.url.includes('/read-state')) {
        return json({
          directConversationId: 'dm-lina',
          lastSequenceNo: 2,
          lastReadSequenceNo: 2,
          unreadCount: 0,
        });
      }
      if (call.url.includes('/direct-conversations/dm-lina/messages')) {
        if (call.method === 'POST') {
          return (overrides.post ?? (() => json(message(3, 'user-omar', 'Sure.'), 201)))(call);
        }
        return (
          overrides.messages ??
          (() =>
            json({
              messages: [
                message(1, 'user-lina', 'Morning! Do you have five minutes?'),
                message(2, 'user-omar', 'Sure. Send me the frames.', 14),
              ],
            }))
        )(call);
      }
      if (call.url.includes('/direct-conversations')) {
        return json({ conversations: [dm({ unreadCount: 1, lastSequenceNo: 2 })] });
      }
      if (call.url.includes('/members')) {
        return json({
          members: [
            { userId: 'user-lina', displayName: 'Lina Samir', role: 'member', status: 'active' },
            { userId: 'user-omar', displayName: 'Omar Adel', role: 'owner', status: 'active' },
          ],
          nextAfter: null,
        });
      }
      if (call.url.includes('/realtime/tickets')) {
        return json({ ticket: 'tkt', expiresAt: '', socketUrl: 'wss://rt.example.test' }, 201);
      }
      if (call.url.includes('/conversations/directory')) return json(DIRECTORY);
      if (call.url.includes('/projects')) return json(PROJECTS);
      return json({}, 404);
    };
  }

  it('opens on the start lines, a TODAY divider and the messages, and marks it read', async () => {
    const { client, calls } = clientOver(dmHandler());
    render(
      wrap(
        <DirectMessageScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          directConversationId="dm-lina"
          client={client}
          socketFactory={() => null}
        />,
      ),
    );

    expect(
      await screen.findByText('This is the start of your direct messages with Lina Samir.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Only the two of you can see this conversation.')).toBeInTheDocument();
    expect(screen.getByRole('separator')).toHaveTextContent('Today');
    expect(screen.getByText('Morning! Do you have five minutes?')).toBeInTheDocument();
    expect(screen.getByText('09:14')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Lina Samir' })).toBeInTheDocument();
    expect(screen.getByLabelText('Message Lina Samir')).toBeInTheDocument();

    await waitFor(() =>
      expect(
        calls.find(
          (c) => c.method === 'PUT' && c.url.endsWith('/direct-conversations/dm-lina/read-state'),
        ),
      ).toBeDefined(),
    );
    // The open conversation's own row carries no unread pill.
    const row = await screen.findByRole('link', { name: /Lina Samir/ });
    expect(row).toHaveAttribute('aria-current', 'page');
    expect(within(row).queryByText('1')).not.toBeInTheDocument();
  });

  it('keeps one clientGeneratedId across a retried send', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const { client, calls } = clientOver(
      dmHandler({
        post: () => {
          attempts += 1;
          if (attempts === 1)
            return json({ error: { code: 'internal', message: 'Try again' } }, 500);
          return json(message(3, 'user-omar', 'Sure.'), 200);
        },
      }),
    );
    render(
      wrap(
        <DirectMessageScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          directConversationId="dm-lina"
          client={client}
          socketFactory={() => null}
        />,
      ),
    );

    const box = await screen.findByLabelText('Message Lina Samir');
    await user.type(box, 'On it');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Not sent')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(box).toHaveValue(''));

    const posts = calls.filter((c) => c.method === 'POST' && c.url.includes('/messages'));
    expect(posts).toHaveLength(2);
    const ids = posts.map((c) => (c.body as { clientGeneratedId: string }).clientGeneratedId);
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBe(ids[0]);
    expect((posts[0]?.body as { body: string }).body).toBe('On it');
  });

  it('subscribes to the DM id on the realtime hub and refetches on a frame', async () => {
    const sockets: LiveSocket[] = [];
    const sent: string[] = [];
    const { client, calls } = clientOver(dmHandler());
    render(
      wrap(
        <DirectMessageScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          directConversationId="dm-lina"
          client={client}
          socketFactory={() => {
            const socket: LiveSocket = {
              send: (text) => sent.push(text),
              close: () => {},
              onopen: null,
              onmessage: null,
              onclose: null,
            };
            sockets.push(socket);
            return socket;
          }}
        />,
      ),
    );

    await waitFor(() => expect(sockets).toHaveLength(1));
    act(() => sockets[0]?.onopen?.());
    expect(JSON.parse(sent[0] as string)).toEqual({ type: 'subscribe', conversationId: 'dm-lina' });
    const before = calls.filter((c) => c.url.includes('/dm-lina/messages')).length;
    act(() =>
      sockets[0]?.onmessage?.({
        data: JSON.stringify({ type: 'event', conversationId: 'dm-lina' }),
      }),
    );
    await waitFor(() =>
      expect(calls.filter((c) => c.url.includes('/dm-lina/messages')).length).toBeGreaterThan(
        before,
      ),
    );
  });
});

describe('New message', () => {
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
    expect(within(dialog).getByText('Member · Northstar Studio')).toBeInTheDocument();
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
