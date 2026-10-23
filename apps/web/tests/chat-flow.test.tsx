import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ChatScreen } from '../src/components/screens/ChatScreen';
import { ProjectChannelScreen } from '../src/components/screens/ProjectChannelScreen';
import { ApiClient } from '../src/lib/api/client';
import { MAX_MESSAGE_PAGE } from '../src/lib/api/conversations';
import type { LiveSocket } from '../src/lib/use-channel-live-feed';
import { authBoundary } from '../src/lib/auth-boundary';
import { expectNoAxeViolations } from './axe';
import { expectInertUntilAnswered, heldAnswer } from './hydration-gate';

/**
 * `TM-06`, `TM-08` and `TM-09` against the endpoints CHAT-001 through CHAT-003 delivered —
 * WEB-003, both halves. The second half's describes are at the end: the rich composer
 * (notation to grammar, previewed through the transcript's own renderer, plain drafts kept
 * plain) and transcript paging on the sequence-number cursor. The notation-to-grammar
 * conversion itself is enumerated in `rich-composer.test.ts`.
 *
 * What the API does — the sequence allocator, the sanitiser, the dedupe on a client-generated
 * id, the conversion's unique key, the moderation ledger — is proved in
 * `chat-001-conversations.db.test.ts`, `chat-002-rich-text.db.test.ts` and
 * `chat-003-message-to-work.db.test.ts` against a real MySQL. Nothing here re-proves any of
 * it.
 *
 * What only this file can prove is what the *screens* do with those answers:
 *
 * - The composer keeps one `clientGeneratedId` across retries of a failed send, which is what
 *   makes the API's dedupe reachable from a browser at all.
 * - A thread is read with `parentMessageId` as a query parameter — the pane never filters the
 *   channel in the browser.
 * - The convert dialog defaults the title from the message and the audience to internal,
 *   warns before a client-facing choice, and shows the *existing* conversion when the API
 *   answers `created: false`.
 * - A moderated message renders as a tombstone, with no convert action on it.
 * - Rich text renders as elements, never as HTML — a body that says `<script>` renders as
 *   those characters.
 */

interface Call {
  readonly url: string;
  readonly method: string | undefined;
  readonly body: unknown;
}

function clientOver(handler: (call: Call) => Response | Promise<Response>): {
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
        method: init?.method,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      };
      calls.push(call);
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

const CONVERSATION = {
  id: 'conv-1',
  projectId: 'proj-1',
  name: 'atlas-relaunch',
  createdByUserId: 'user-1111',
  version: 1,
  createdAt: '2026-08-26T00:00:00.000Z',
  updatedAt: '2026-08-26T00:00:00.000Z',
  archivedAt: null,
};

const PROJECT = {
  id: 'proj-1',
  workspaceId: 'ws-1',
  name: 'Atlas Website Relaunch',
  status: 'active',
  ownerUserId: 'user-1111',
  committedAt: null,
  forecastAt: null,
  createdAt: '2026-08-26T00:00:00.000Z',
  updatedAt: '2026-08-26T00:00:00.000Z',
  archivedAt: null,
};

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    authorUserId: 'user-aaaa-1111',
    sequenceNo: 1,
    parentMessageId: null,
    body: 'The homepage hero needs a rewrite.\nSecond line with detail.',
    bodyRich: null,
    editedAt: null,
    deletedAt: null,
    deletedByUserId: null,
    createdAt: '2026-08-27T10:00:00.000Z',
    updatedAt: '2026-08-27T10:00:00.000Z',
    ...overrides,
  };
}

const RICH_MESSAGE = message({
  id: 'msg-2',
  sequenceNo: 2,
  body: 'Bold words and a link and <script>alert(1)</script>',
  bodyRich: {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Bold words', marks: [{ type: 'bold' }] },
          { type: 'text', text: ' and ' },
          {
            type: 'text',
            text: 'a link',
            marks: [{ type: 'link', href: 'https://example.com/brief' }],
          },
          { type: 'text', text: ' and <script>alert(1)</script>' },
        ],
      },
    ],
  },
});

const MODERATED_MESSAGE = message({
  id: 'msg-3',
  sequenceNo: 3,
  body: null,
  bodyRich: null,
  deletedAt: '2026-08-27T12:00:00.000Z',
  deletedByUserId: 'user-mod',
});

/** Routes a channel-screen request. Most specific paths first — `/work-items` and
 * `/revisions` both contain `/messages`. */
function channelHandler(
  overrides: Partial<Record<string, (call: Call) => Response | Promise<Response>>> = {},
) {
  return (call: Call): Response | Promise<Response> => {
    if (call.url.includes('/work-items')) {
      return (overrides['convert'] ?? (() => json({}, 500)))(call);
    }
    if (call.url.includes('/revisions')) {
      return (overrides['revisions'] ?? (() => json({ revisions: [] })))(call);
    }
    // A16: the reaction pills, attachment cards, Members panel and channel counts.
    if (/\/organizations\/northstar\/members/u.test(call.url)) {
      return (overrides['orgMembers'] ?? (() => json({}, 404)))(call);
    }
    if (call.url.includes('/reactions')) {
      return (overrides['reactions'] ?? (() => json({ messageId: 'msg-1', reactions: [] })))(call);
    }
    if (call.url.includes('/attachments')) {
      return (overrides['attachments'] ?? (() => json({ attachments: [] })))(call);
    }
    if (call.url.includes('/conversations/conv-1/members')) {
      return (overrides['members'] ?? (() => json({ members: [] })))(call);
    }
    if (call.url.includes('/conversations/directory')) {
      return (overrides['directory'] ?? (() => json({}, 404)))(call);
    }
    if (call.url.includes('/messages')) {
      if (call.method === 'PATCH') {
        return (
          overrides['edit'] ?? (() => json(message({ editedAt: '2026-08-27T12:00:00.000Z' })))
        )(call);
      }
      if (call.method === 'POST') {
        return (overrides['post'] ?? (() => json(message({ id: 'msg-new' }), 201)))(call);
      }
      if (call.method === 'DELETE') {
        return (overrides['moderate'] ?? (() => json(MODERATED_MESSAGE)))(call);
      }
      if (call.url.includes('parentMessageId=')) {
        return (overrides['replies'] ?? (() => json({ messages: [] })))(call);
      }
      return (
        overrides['messages'] ??
        (() => json({ messages: [message(), RICH_MESSAGE, MODERATED_MESSAGE] }))
      )(call);
    }
    if (call.url.includes('/realtime/tickets')) {
      return (
        overrides['ticket'] ??
        (() =>
          json({ ticket: 'tkt-1', expiresAt: '2026-08-30T00:01:00.000Z', socketUrl: null }, 201))
      )(call);
    }
    if (call.url.includes('/conversations/conv-1')) return json(CONVERSATION);
    if (call.url.includes('/projects/proj-1')) return json(PROJECT);
    return json({}, 404);
  };
}

function renderChannel(client: ApiClient) {
  return render(
    withQuery(
      <ProjectChannelScreen
        organizationSlug="northstar"
        organizationName="Northstar Studio"
        conversationId="conv-1"
        client={client}
      />,
    ),
  );
}

/** A CH-01 directory row: the conversation plus members and activity. */
function directoryEntry(overrides: Record<string, unknown> = {}) {
  return {
    ...CONVERSATION,
    lastActivityAt: '2026-08-26T00:00:00.000Z',
    memberCount: 1,
    clientMemberCount: 0,
    joined: false,
    memberPreview: [{ userId: 'user-1111', displayName: 'Omar Aziz', isClient: false }],
    ...overrides,
  };
}

describe('the channel list', () => {
  it('lists channels with their project, members and audience, and links into them', async () => {
    const { client } = clientOver((call) => {
      if (call.url.includes('/conversations/directory')) {
        return json({
          channels: [
            directoryEntry({
              memberCount: 3,
              clientMemberCount: 1,
              joined: true,
              memberPreview: [
                { userId: 'user-1111', displayName: 'Omar Aziz', isClient: false },
                { userId: 'user-2222', displayName: 'Yuki Kato', isClient: true },
              ],
            }),
          ],
        });
      }
      if (call.url.includes('/projects')) return json({ projects: [PROJECT] });
      return json({ conversations: [] });
    });

    render(
      withQuery(
        <ChatScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          client={client}
        />,
      ),
    );

    const link = await screen.findByRole('link', { name: '#atlas-relaunch' });
    expect(link).toHaveAttribute('href', '/northstar/chat/conv-1');
    const row = link.closest('li') as HTMLElement;
    expect(await within(row).findByText('Atlas Website Relaunch')).toBeInTheDocument();
    expect(within(row).getByText('joined')).toBeInTheDocument();
    expect(within(row).getByText('YK')).toBeInTheDocument();
    expect(within(row).getByText('2 + 1')).toBeInTheDocument();
    expect(within(row).getByText('Client visible')).toBeInTheDocument();
  });

  it('filters by my channels, client shared and archived, with counts', async () => {
    const user = userEvent.setup();
    const { client } = clientOver((call) => {
      if (call.url.includes('/conversations/directory')) {
        return json({
          channels: [
            directoryEntry({ id: 'c-mine', name: 'mine', joined: true }),
            directoryEntry({ id: 'c-client', name: 'shared', clientMemberCount: 1 }),
            directoryEntry({ id: 'c-old', name: 'old', archivedAt: '2026-08-27T00:00:00.000Z' }),
          ],
        });
      }
      if (call.url.includes('/projects')) return json({ projects: [PROJECT] });
      return json({ conversations: [] });
    });

    render(
      withQuery(
        <ChatScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          client={client}
        />,
      ),
    );

    await screen.findByRole('link', { name: '#mine' });
    expect(screen.queryByRole('link', { name: '#old' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'My channels · 1' }));
    expect(screen.getAllByRole('link').map((l) => l.textContent)).toContain('#mine');
    expect(screen.queryByRole('link', { name: '#shared' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Client shared · 1' }));
    expect(screen.getByRole('link', { name: '#shared' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '#mine' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Archived · 1' }));
    expect(screen.getByRole('link', { name: '#old' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All · 2' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  /**
   * The x38 defect (CL-09) on TM-08. The channel form's controls are controlled inputs in the
   * server-rendered HTML; a name typed before React hydrated was held by the DOM alone and
   * undone by hydration, with nothing said. They sit behind `disabled={projects.isPending}`.
   */
  it('takes no channel name until the projects have arrived', async () => {
    const user = userEvent.setup();
    const held = heldAnswer();
    const { client } = clientOver((call) => {
      if (call.url.includes('/projects')) return held.after(() => json({ projects: [PROJECT] }));
      if (call.url.includes('/conversations/directory')) return json({ channels: [] });
      return json({ conversations: [] });
    });

    render(
      withQuery(
        <ChatScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          client={client}
        />,
      ),
    );

    const name = within(
      screen.getByRole('heading', { name: 'New channel' }).closest('section') as HTMLElement,
    ).getByLabelText('Channel name');
    await expectInertUntilAnswered([name, screen.getByLabelText('Project')], held.answer);

    await user.type(name, 'general');
    expect(name).toHaveValue('general');
  });

  it('creates a channel on the chosen project', async () => {
    const { client, calls } = clientOver((call) => {
      if (call.url.includes('/conversations') && call.method === 'POST') {
        return json({ ...CONVERSATION, id: 'conv-2', name: 'general' }, 201);
      }
      if (call.url.includes('/conversations/directory')) return json({ channels: [] });
      if (call.url.includes('/conversations')) return json({ conversations: [] });
      if (call.url.includes('/projects')) return json({ projects: [PROJECT] });
      return json({}, 404);
    });

    render(
      withQuery(
        <ChatScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          client={client}
        />,
      ),
    );

    const heading = await screen.findByRole('heading', { name: 'New channel' });
    // Scope to the form's section, and wait for the projects query to fill its options.
    const section = heading.closest('section') as HTMLElement;
    await within(section).findByRole('option', { name: 'Atlas Website Relaunch' });
    await userEvent.selectOptions(within(section).getByLabelText('Project'), 'proj-1');
    await userEvent.type(within(section).getByLabelText('Channel name'), 'general');
    await userEvent.click(within(section).getByRole('button', { name: 'Create channel' }));

    await waitFor(() => {
      const create = calls.find((call) => call.method === 'POST');
      expect(create).toBeDefined();
      expect(create?.body).toEqual({ projectId: 'proj-1', name: 'general' });
    });
  });
});

describe('TM-06 the project channel', () => {
  it('renders the transcript oldest first, with the moderated tombstone and no axe violations', async () => {
    const { client } = clientOver(channelHandler());
    const { container } = renderChannel(client);

    await screen.findByText('The homepage hero needs a rewrite. Second line with detail.', {
      exact: false,
    });
    expect(screen.getByText(/Removed by a moderator/)).toBeInTheDocument();

    // The moderated message offers no conversion and no removal — there is nothing to convert
    // and nothing further to remove.
    const list = screen.getByRole('list', { name: 'Messages, oldest first' });
    const items = within(list).getAllByRole('listitem');
    const lastItem = items[items.length - 1] as HTMLElement;
    expect(within(lastItem).queryByRole('button', { name: 'Create work from this' })).toBeNull();
    expect(within(lastItem).queryByRole('button', { name: 'Remove' })).toBeNull();

    await expectNoAxeViolations(container);
  });

  it('renders rich text as elements and script tags as text', async () => {
    const { client } = clientOver(channelHandler());
    renderChannel(client);

    const bold = await screen.findByText('Bold words');
    expect(bold.tagName).toBe('STRONG');

    const link = screen.getByRole('link', { name: 'a link' });
    expect(link).toHaveAttribute('href', 'https://example.com/brief');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');

    // The text said <script>; the DOM must contain those characters and no script element.
    expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeInTheDocument();
    expect(document.querySelector('script[src], .tm-prose script')).toBeNull();
  });

  it('sends a message with a client-generated id, and reuses that id when retrying a failed send', async () => {
    let failNext = true;
    const { client, calls } = clientOver(
      channelHandler({
        post: () => {
          if (failNext) {
            failNext = false;
            throw new Error('offline');
          }
          return json(message({ id: 'msg-new', sequenceNo: 4 }), 201);
        },
      }),
    );
    renderChannel(client);

    await screen.findByLabelText('Message the channel');
    await userEvent.type(screen.getByLabelText('Message the channel'), 'Shipping Friday.');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    await screen.findByText(/sending again cannot post it twice/);
    // The draft survives the failure.
    expect(screen.getByLabelText('Message the channel')).toHaveValue('Shipping Friday.');

    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      const posts = calls.filter(
        (call) => call.method === 'POST' && call.url.endsWith('/messages'),
      );
      expect(posts).toHaveLength(2);
      const first = posts[0]?.body as { clientGeneratedId: string };
      const second = posts[1]?.body as { clientGeneratedId: string };
      expect(first.clientGeneratedId).toBeTruthy();
      expect(second.clientGeneratedId).toBe(first.clientGeneratedId);
    });
  });

  it('sends on Enter and inserts a newline on Shift+Enter (COL-13)', async () => {
    const { client, calls } = clientOver(
      channelHandler({
        post: () => json(message({ id: 'msg-new', sequenceNo: 4 }), 201),
      }),
    );
    renderChannel(client);

    const box = await screen.findByLabelText('Message the channel');
    // Shift+Enter is a newline, not a send.
    await userEvent.type(box, 'First line{Shift>}{Enter}{/Shift}second line');
    expect(box).toHaveValue('First line\nsecond line');
    expect(
      calls.filter((call) => call.method === 'POST' && call.url.endsWith('/messages')),
    ).toHaveLength(0);

    // Enter alone sends.
    await userEvent.type(box, '{Enter}');
    await waitFor(() => {
      const posts = calls.filter(
        (call) => call.method === 'POST' && call.url.endsWith('/messages'),
      );
      expect(posts).toHaveLength(1);
    });
  });
});

describe('TM-08 the thread pane', () => {
  it('pins the source, reads replies with parentMessageId, and replies into the thread', async () => {
    const { client, calls } = clientOver(
      channelHandler({
        replies: () =>
          json({
            messages: [
              message({
                id: 'reply-1',
                sequenceNo: 5,
                parentMessageId: 'msg-1',
                body: 'Agreed — drafting now.',
              }),
            ],
          }),
      }),
    );
    renderChannel(client);

    const list = await screen.findByRole('list', { name: 'Messages, oldest first' });
    const firstItem = within(list).getAllByRole('listitem')[0] as HTMLElement;
    await userEvent.click(within(firstItem).getByRole('button', { name: 'Reply in thread' }));

    // The replies were asked for, not filtered out of the channel.
    await waitFor(() => {
      const threadRead = calls.find((call) => call.url.includes('parentMessageId=msg-1'));
      expect(threadRead).toBeDefined();
    });
    await screen.findByText('Agreed — drafting now.');

    // Two composers are on screen — the channel's and the thread's. Send from the thread's.
    const replyBox = screen.getByLabelText('Reply in this thread');
    await userEvent.type(replyBox, 'Send it to review.');
    const replyForm = replyBox.closest('form') as HTMLElement;
    await userEvent.click(within(replyForm).getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      const reply = calls.find(
        (call) =>
          call.method === 'POST' &&
          call.url.endsWith('/messages') &&
          (call.body as { parentMessageId?: string }).parentMessageId === 'msg-1',
      );
      expect(reply).toBeDefined();
    });
  });

  it('moves focus into the pane on every open, not only the first (WCAG 2.4.3)', async () => {
    const { client, calls } = clientOver(channelHandler());
    renderChannel(client);

    const list = await screen.findByRole('list', { name: 'Messages, oldest first' });
    const items = within(list).getAllByRole('listitem');
    const openA = within(items[0] as HTMLElement).getByRole('button', { name: 'Reply in thread' });
    const openB = within(items[1] as HTMLElement).getByRole('button', { name: 'Reply in thread' });

    await userEvent.click(openA);
    await waitFor(() => {
      expect(calls.some((call) => call.url.includes('parentMessageId=msg-1'))).toBe(true);
    });
    const headingA = await screen.findByRole('heading', { name: 'Thread' });
    expect(headingA).toHaveFocus();

    // Opening B while A's pane is open: the click puts focus back on the trigger, so if the pane
    // were only re-rendered (no remount) focus would stay there and nothing would announce.
    await userEvent.click(openB);
    await waitFor(() => {
      expect(calls.some((call) => call.url.includes('parentMessageId=msg-2'))).toBe(true);
    });
    const headingB = await screen.findByRole('heading', { name: 'Thread' });
    expect(headingB).toHaveFocus();
    expect(headingB).not.toBe(headingA); // a fresh mount, not the same pane re-rendered
  });

  /**
   * WCAG 2.2 4.1.3, verbosity — the x46 pattern (61f4f44) carried over to the thread pane. The
   * replies <ol> is a polite live region so a genuinely new reply (one that arrives through the
   * ordinary refetch path) is announced. "Load more replies" appends a whole page at once, which
   * a live region would read out in full: the region is held silent across the page fetch and
   * speaks again once it lands.
   */
  it('silences the replies live region for a Load more page and speaks again after (WCAG 2.2 4.1.3)', async () => {
    const firstPage = Array.from({ length: MAX_MESSAGE_PAGE }, (_, index) =>
      message({
        id: `reply-${index + 1}`,
        sequenceNo: index + 5,
        parentMessageId: 'msg-1',
        body: `Reply ${index + 1}`,
      }),
    );
    const held = heldAnswer();
    const { client } = clientOver(
      channelHandler({
        // The first page fills the region; the load-more page (afterSequenceNo present) is held so
        // the fetch can be observed in flight.
        replies: (call) =>
          call.url.includes('afterSequenceNo=')
            ? held.after(() =>
                json({
                  messages: [
                    message({
                      id: 'reply-late',
                      sequenceNo: 400,
                      parentMessageId: 'msg-1',
                      body: 'A later reply',
                    }),
                  ],
                }),
              )
            : json({ messages: firstPage }),
      }),
    );
    renderChannel(client);

    const list = await screen.findByRole('list', { name: 'Messages, oldest first' });
    const firstItem = within(list).getAllByRole('listitem')[0] as HTMLElement;
    await userEvent.click(within(firstItem).getByRole('button', { name: 'Reply in thread' }));

    const replies = await screen.findByRole('list', { name: 'Replies, oldest first' });
    // A newly arrived reply would land in an announced region.
    expect(replies).toHaveAttribute('aria-live', 'polite');

    // The whole appended page must not be read out: the region is off while the page fetches.
    await userEvent.click(screen.getByRole('button', { name: 'Load more replies' }));
    await waitFor(() => expect(replies).toHaveAttribute('aria-live', 'off'));

    // Once the page has landed the region speaks again for the next live reply.
    held.answer();
    await waitFor(() => expect(replies).toHaveAttribute('aria-live', 'polite'));
  });
});

describe('TM-09 the convert dialog', () => {
  async function openDialog(client: ApiClient) {
    renderChannel(client);
    const list = await screen.findByRole('list', { name: 'Messages, oldest first' });
    const firstItem = within(list).getAllByRole('listitem')[0] as HTMLElement;
    // A16: Create work sits in the hover bar's ⋯ menu.
    await userEvent.click(within(firstItem).getByRole('button', { name: 'More actions' }));
    await userEvent.click(within(firstItem).getByRole('button', { name: 'Create work from this' }));
    await screen.findByRole('form', { name: 'Create work from this message' });
  }

  it('defaults the title from the first line and the audience to internal, and files on the channel project', async () => {
    const { client, calls } = clientOver(
      channelHandler({
        convert: () =>
          json(
            {
              workItem: { id: 'wi-9', title: 'The homepage hero needs a rewrite.' },
              messageId: 'msg-1',
              convertedAt: '2026-08-30T00:00:00.000Z',
              created: true,
            },
            201,
          ),
      }),
    );
    await openDialog(client);

    expect(screen.getByLabelText('Title')).toHaveValue('The homepage hero needs a rewrite.');
    expect(screen.getByRole('radio', { name: 'Internal' })).toBeChecked();
    // The project is stated, never offered as a choice.
    expect(screen.getByText(/not a choice/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Create work item' }));

    const done = await screen.findByText('Work item created');
    expect(done).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'The homepage hero needs a rewrite.' }),
    ).toHaveAttribute('href', '/northstar/work/wi-9');

    const convert = calls.find((call) => call.url.includes('/work-items'));
    expect(convert?.body).toMatchObject({
      title: 'The homepage hero needs a rewrite.',
      audience: 'internal',
    });
    expect(convert?.body).not.toHaveProperty('ownerUserId');
  });

  it('warns before a client-facing audience is chosen', async () => {
    const { client } = clientOver(channelHandler());
    await openDialog(client);

    expect(screen.queryByText(/visible to the client/)).toBeNull();
    await userEvent.click(screen.getByRole('radio', { name: 'Client can see' }));
    expect(screen.getByText('This work item will be visible to the client')).toBeInTheDocument();
  });

  it('shows the existing conversion when the API answers created: false', async () => {
    const { client } = clientOver(
      channelHandler({
        convert: () =>
          json({
            workItem: { id: 'wi-original', title: 'Rewrite the hero' },
            messageId: 'msg-1',
            convertedAt: '2026-08-28T00:00:00.000Z',
            created: false,
          }),
      }),
    );
    await openDialog(client);
    await userEvent.click(screen.getByRole('button', { name: 'Create work item' }));

    await screen.findByText('Already converted');
    expect(screen.getByText(/exactly once/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Rewrite the hero' })).toHaveAttribute(
      'href',
      '/northstar/work/wi-original',
    );
  });
});

describe('the rich composer — WEB-003 second half', () => {
  it('converts notation to the grammar, previews it, and sends bodyRich with no notation in it', async () => {
    const { client, calls } = clientOver(channelHandler());
    renderChannel(client);

    const box = await screen.findByLabelText('Message the channel');
    await userEvent.type(box, '**Ship it** on Friday');

    // The preview renders the *converted* document through the transcript's own renderer.
    const preview = await screen.findByRole('region', { name: 'Preview' });
    const bold = within(preview).getByText('Ship it');
    expect(bold.tagName).toBe('STRONG');

    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      const post = calls.find((call) => call.method === 'POST' && call.url.endsWith('/messages'));
      expect(post).toBeDefined();
      const body = post?.body as {
        body?: string;
        bodyRich?: { content: readonly unknown[] };
      };
      // The grammar travels; the notation does not, and neither does a plain body.
      expect(body.body).toBeUndefined();
      expect(body.bodyRich).toMatchObject({ type: 'doc' });
      expect(JSON.stringify(body.bodyRich)).not.toContain('**');
      expect(JSON.stringify(body.bodyRich)).toContain('"type":"bold"');
    });
  });

  it('sends an unformatted draft as plain body, with no rich document invented', async () => {
    const { client, calls } = clientOver(channelHandler());
    renderChannel(client);

    const box = await screen.findByLabelText('Message the channel');
    await userEvent.type(box, 'Just words, no formatting.');
    expect(screen.queryByRole('region', { name: 'Preview' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      const post = calls.find((call) => call.method === 'POST' && call.url.endsWith('/messages'));
      const body = post?.body as { body?: string; bodyRich?: unknown };
      expect(body.body).toBe('Just words, no formatting.');
      expect(body.bodyRich).toBeUndefined();
    });
  });

  it('the toolbar writes notation around the selection', async () => {
    const { client } = clientOver(channelHandler());
    renderChannel(client);

    const box = (await screen.findByLabelText('Message the channel')) as HTMLTextAreaElement;
    await userEvent.type(box, 'make this bold');
    box.setSelectionRange(5, 9); // "this"
    // A16: the formatting toolbar sits behind the composer's "+".
    await userEvent.click(screen.getByRole('button', { name: 'Formatting' }));
    await userEvent.click(screen.getByRole('button', { name: 'Bold' }));

    expect(box).toHaveValue('make **this** bold');
  });
});

describe('transcript paging — WEB-003 second half', () => {
  function pageOf(count: number, firstSequence: number) {
    return Array.from({ length: count }, (_, position) =>
      message({
        id: `msg-page-${firstSequence + position}`,
        sequenceNo: firstSequence + position,
        body: `Message number ${firstSequence + position}`,
      }),
    );
  }

  it('offers Load more on a full page, continues from the last sequence number, and stops on a short page', async () => {
    const { client, calls } = clientOver(
      channelHandler({
        messages: (call) =>
          call.url.includes('afterSequenceNo=200')
            ? json({ messages: pageOf(3, 201) })
            : json({ messages: pageOf(200, 1) }),
      }),
    );
    renderChannel(client);

    // A full page: the screen says so rather than presenting it as everything.
    await screen.findByText('This is not the whole transcript');
    expect(screen.getByText(/200 messages loaded — there are more/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));

    // The next page was asked for with the transcript's own cursor, and appended.
    await screen.findByText('Message number 203');
    const paged = calls.find((call) => call.url.includes('afterSequenceNo=200'));
    expect(paged).toBeDefined();
    expect(screen.getByText('Message number 1')).toBeInTheDocument();

    // A short page means the transcript is now whole: no button, no warning.
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(screen.queryByText('This is not the whole transcript')).toBeNull();
  });
});

describe('the live feed — RT-001 second half', () => {
  class FakeSocket implements LiveSocket {
    readonly sent: string[] = [];
    closed = false;
    onopen: (() => void) | null = null;
    onmessage: ((event: { readonly data: unknown }) => void) | null = null;
    onclose: (() => void) | null = null;
    send(text: string): void {
      this.sent.push(text);
    }
    close(): void {
      // The screen unmounting closes the socket; the hook must not treat that as a drop.
      this.closed = true;
    }
    emitOpen(): void {
      act(() => this.onopen?.());
    }
    emit(frame: Record<string, unknown>): void {
      act(() => this.onmessage?.({ data: JSON.stringify(frame) }));
    }
    drop(): void {
      act(() => this.onclose?.());
    }
  }

  it('mints, subscribes, shows Live, and refetches on every frame — never patching from it', async () => {
    let extra = false;
    const sockets: FakeSocket[] = [];
    const { client, calls } = clientOver(
      channelHandler({
        ticket: () =>
          json(
            { ticket: 'tkt-1', expiresAt: '2026-08-30T00:01:00.000Z', socketUrl: 'ws://sock.test' },
            201,
          ),
        messages: () =>
          json({
            messages: extra
              ? [
                  message(),
                  RICH_MESSAGE,
                  MODERATED_MESSAGE,
                  message({ id: 'msg-live', sequenceNo: 4, body: 'Arrived live.' }),
                ]
              : [message(), RICH_MESSAGE, MODERATED_MESSAGE],
          }),
      }),
    );

    render(
      withQuery(
        <ProjectChannelScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          conversationId="conv-1"
          client={client}
          socketFactory={(url) => {
            expect(url).toContain('ws://sock.test');
            expect(url).toContain('ticket=tkt-1');
            const socket = new FakeSocket();
            sockets.push(socket);
            return socket;
          }}
          reconnectBaseMs={1}
        />,
      ),
    );

    await waitFor(() => expect(sockets).toHaveLength(1));

    // Minor 1: while the socket is 'connecting' the status span is deliberately empty, so the
    // header line must not trail a dangling ' · ' separator with nothing after it.
    expect(screen.getByText(/^Project channel · /u).textContent?.replace(/\s+$/u, '')).not.toMatch(
      /·$/u,
    );

    const socket = sockets[0] as FakeSocket;
    socket.emitOpen();
    expect(socket.sent).toEqual([JSON.stringify({ type: 'subscribe', conversationId: 'conv-1' })]);

    socket.emit({ type: 'subscribed', conversationId: 'conv-1', cursor: 3 });
    await screen.findByText('Live updates connected');

    // A frame carries ids only; the screen refetches and the new message arrives through
    // the ordinary read path — the frame's own content is never rendered.
    extra = true;
    socket.emit({
      type: 'event',
      eventType: 'message.created.v1',
      conversationId: 'conv-1',
      objectId: 'msg-live',
      sequence: 4,
      patch: { parentMessageId: null },
    });
    await screen.findByText('Arrived live.');

    const reads = calls.filter(
      (call) =>
        (call.method === undefined || call.method === 'GET') && call.url.includes('/messages'),
    );
    expect(reads.length).toBeGreaterThanOrEqual(2);
  });

  it('settles quietly when the deployment runs no socket', async () => {
    const factoryCalls: string[] = [];
    const { client, calls } = clientOver(channelHandler());
    render(
      withQuery(
        <ProjectChannelScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          conversationId="conv-1"
          client={client}
          socketFactory={(url) => {
            factoryCalls.push(url);
            return new FakeSocket();
          }}
        />,
      ),
    );

    await waitFor(() => {
      expect(calls.some((call) => call.url.includes('/realtime/tickets'))).toBe(true);
    });
    // socketUrl: null — no dial, no chip, the reload behaviour stands.
    expect(factoryCalls).toHaveLength(0);
    expect(screen.queryByText('Live updates connected')).toBeNull();
    expect(screen.queryByText('Reconnecting to live updates')).toBeNull();
  });

  it('a dropped socket reconnects with a fresh ticket', async () => {
    const sockets: FakeSocket[] = [];
    const { client, calls } = clientOver(
      channelHandler({
        ticket: () =>
          json(
            { ticket: 'tkt-1', expiresAt: '2026-08-30T00:01:00.000Z', socketUrl: 'ws://sock.test' },
            201,
          ),
      }),
    );

    render(
      withQuery(
        <ProjectChannelScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          conversationId="conv-1"
          client={client}
          socketFactory={() => {
            const socket = new FakeSocket();
            sockets.push(socket);
            return socket;
          }}
          reconnectBaseMs={1}
        />,
      ),
    );

    await waitFor(() => expect(sockets).toHaveLength(1));
    (sockets[0] as FakeSocket).drop();
    await screen.findByText('Reconnecting to live updates');

    // A fresh mint and a fresh socket — the sixty-second ticket is never reused.
    await waitFor(() => {
      const mints = calls.filter((call) => call.url.includes('/realtime/tickets'));
      expect(mints.length).toBeGreaterThanOrEqual(2);
      expect(sockets.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('a revoked channel stops reconnecting and shows a channel-scoped notice, leaving the session alone', async () => {
    const sockets: FakeSocket[] = [];
    const { client, calls } = clientOver(
      channelHandler({
        ticket: () =>
          json(
            { ticket: 'tkt-1', expiresAt: '2026-08-30T00:01:00.000Z', socketUrl: 'ws://sock.test' },
            201,
          ),
      }),
    );

    const notices: string[] = [];
    const stop = authBoundary.subscribe((notice) => notices.push(notice.event));

    try {
      render(
        withQuery(
          <ProjectChannelScreen
            organizationSlug="northstar"
            organizationName="Northstar Studio"
            conversationId="conv-1"
            client={client}
            socketFactory={() => {
              const socket = new FakeSocket();
              sockets.push(socket);
              return socket;
            }}
            // Tiny, so that if the hook wrongly scheduled a retry it would have fired by the
            // time the assertions run — proving the absence of a reconnect, not just its delay.
            reconnectBaseMs={1}
          />,
        ),
      );

      await waitFor(() => expect(sockets).toHaveLength(1));
      const socket = sockets[0] as FakeSocket;
      socket.emitOpen();
      socket.emit({ type: 'subscribed', conversationId: 'conv-1', cursor: 3 });
      await screen.findByText('Live updates connected');
      // The transcript and the composer are on screen right up to the revoke, so their
      // absence afterwards is this frame's doing and not a screen that never loaded.
      await screen.findByLabelText('Messages, oldest first');
      await screen.findByLabelText('Message the channel');

      // Authority for this channel is withdrawn. That is a statement about the channel, not
      // about the session: the transcript and composer go, the notice explains why, and the
      // person stays signed in — no `session-ended`, so no cache clear and no cross-tab
      // sign-out of a session the server never ended.
      socket.emit({ type: 'revoked', conversationId: 'conv-1' });

      await screen.findByText('You no longer have access to this channel');
      expect(screen.queryByLabelText('Messages, oldest first')).toBeNull();
      expect(screen.queryByLabelText('Message the channel')).toBeNull();
      expect(notices).toEqual([]);

      // Terminal, not a drop: the socket is closed, the live chip is gone, and there is no
      // "Reconnecting…" — no fresh mint, no fresh socket, however long we wait.
      expect(socket.closed).toBe(true);
      expect(screen.queryByText('Live updates connected')).toBeNull();
      expect(screen.queryByText('Reconnecting to live updates')).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sockets).toHaveLength(1);
      expect(calls.filter((call) => call.url.includes('/realtime/tickets'))).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it('a refused re-subscribe after a reconnect ends the channel the same way', async () => {
    // The revocation path a default deployment actually takes: the worker closes the socket
    // 4401 when the ticket TTL lapses, the hook re-mints on a still-valid session and
    // re-subscribes, and the server's current-rows check answers `refused`. Retrying that is
    // a channel parked on "Reconnecting…" that will never reconnect.
    const sockets: FakeSocket[] = [];
    const { client } = clientOver(
      channelHandler({
        ticket: () =>
          json(
            { ticket: 'tkt-1', expiresAt: '2026-08-30T00:01:00.000Z', socketUrl: 'ws://sock.test' },
            201,
          ),
      }),
    );

    render(
      withQuery(
        <ProjectChannelScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          conversationId="conv-1"
          client={client}
          socketFactory={() => {
            const socket = new FakeSocket();
            sockets.push(socket);
            return socket;
          }}
          reconnectBaseMs={1}
        />,
      ),
    );

    await waitFor(() => expect(sockets).toHaveLength(1));
    const first = sockets[0] as FakeSocket;
    first.emitOpen();
    first.emit({ type: 'subscribed', conversationId: 'conv-1', cursor: 3 });
    await screen.findByText('Live updates connected');

    // The ticket's TTL lapses: an ordinary close, which still reconnects.
    first.drop();
    await waitFor(() => expect(sockets.length).toBeGreaterThanOrEqual(2));
    const second = sockets[1] as FakeSocket;
    second.emitOpen();
    second.emit({ type: 'refused', conversationId: 'conv-1' });

    await screen.findByText('You no longer have access to this channel');
    expect(second.closed).toBe(true);
    expect(screen.queryByText('Reconnecting to live updates')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sockets).toHaveLength(2);
  });
});

describe('A16 chat basics — members panel, inline edit, reactions', () => {
  const ORG_MEMBERS = {
    members: [
      { userId: 'user-aaaa-1111', displayName: 'Lina Samir', role: 'member', status: 'active' },
      { userId: 'user-omar', displayName: 'Omar Adel', role: 'owner', status: 'active' },
      { userId: 'user-salma', displayName: 'Salma Riad', role: 'client', status: 'active' },
      { userId: 'user-nour', displayName: 'Nour Ali', role: 'member', status: 'active' },
    ],
    nextAfter: null,
  };

  it('counts internal and client members in the header and groups them in the Members panel', async () => {
    const { client } = clientOver(
      channelHandler({
        orgMembers: () => json(ORG_MEMBERS),
        members: () =>
          json({
            members: [
              { userId: 'user-aaaa-1111', joinedAt: '2026-08-26T00:00:00.000Z' },
              { userId: 'user-omar', joinedAt: '2026-08-26T00:00:00.000Z' },
              { userId: 'user-salma', joinedAt: '2026-08-26T00:00:00.000Z' },
            ],
          }),
        directory: () =>
          json({
            channels: [
              directoryEntry({
                memberCount: 3,
                clientMemberCount: 1,
                memberPreview: [
                  { userId: 'user-salma', displayName: 'Salma Riad', isClient: true },
                ],
              }),
            ],
          }),
      }),
    );
    renderChannel(client);

    expect(
      await screen.findByText(/Project channel · 2 internal · 1 client members/u),
    ).toBeInTheDocument();
    expect(screen.getByText('Client visible')).toBeInTheDocument();

    const panel = await screen.findByRole('region', { name: 'Members' });
    await within(panel).findByText('Salma Riad');
    expect(within(panel).getByText('Internal · 2')).toBeInTheDocument();
    expect(within(panel).getByText('Client · 1')).toBeInTheDocument();
    expect(within(panel).getByText('Lina Samir')).toBeInTheDocument();

    // "Add people" offers only the organization members not in the channel yet.
    await userEvent.click(within(panel).getByRole('button', { name: 'Add people' }));
    const picker = within(panel).getByRole('list', { name: 'Add people' });
    expect(within(picker).getByRole('button', { name: /Nour Ali/u })).toBeInTheDocument();
    expect(within(picker).queryByRole('button', { name: /Omar Adel/u })).toBeNull();
  });

  it('edits a message in place: Enter PATCHes the new body, Esc leaves it untouched', async () => {
    const { client, calls } = clientOver(channelHandler());
    renderChannel(client);

    const list = await screen.findByRole('list', { name: 'Messages, oldest first' });
    const firstItem = within(list).getAllByRole('listitem')[0] as HTMLElement;

    await userEvent.click(within(firstItem).getByRole('button', { name: 'Edit' }));
    expect(within(firstItem).getByText('Enter to save · Esc to cancel')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(within(firstItem).queryByText('Enter to save · Esc to cancel')).toBeNull();
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);

    await userEvent.click(within(firstItem).getByRole('button', { name: 'Edit' }));
    const box = within(firstItem).getByLabelText('Edit message');
    await userEvent.clear(box);
    await userEvent.type(box, 'The hero copy is final.{Enter}');

    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    const patch = calls.find((call) => call.method === 'PATCH');
    expect(patch?.url).toMatch(/\/conversations\/conv-1\/messages\/msg-1$/u);
    expect(patch?.body).toEqual({ body: 'The hero copy is final.' });
    await waitFor(() =>
      expect(within(firstItem).queryByText('Enter to save · Esc to cancel')).toBeNull(),
    );
  });

  it('draws used reactions as pills with counts and toggles the member own reaction', async () => {
    const { client, calls } = clientOver(
      channelHandler({
        reactions: (call) =>
          call.url.includes('/messages/msg-1/')
            ? json({
                messageId: 'msg-1',
                reactions: [
                  { emoji: '❤️', count: 3, reacted: true },
                  { emoji: '\u{2713}', count: 2, reacted: false },
                ],
              })
            : json({ messageId: 'other', reactions: [] }),
      }),
    );
    renderChannel(client);

    const heart = await screen.findByRole('button', { name: 'Heart, 3' });
    expect(heart).toHaveAttribute('aria-pressed', 'true');
    const check = screen.getByRole('button', { name: 'Done, 2' });
    expect(check).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(check);
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.method === 'PUT' &&
            call.url.endsWith('/messages/msg-1/reactions') &&
            (call.body as { emoji?: string }).emoji === '\u{2713}',
        ),
      ).toBe(true),
    );
  });
});
