import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ChatScreen } from '../src/components/screens/ChatScreen';
import { ProjectChannelScreen } from '../src/components/screens/ProjectChannelScreen';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * `TM-06`, `TM-08` and `TM-09` against the endpoints CHAT-001 through CHAT-003 delivered —
 * WEB-003's first half.
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

function clientOver(handler: (call: Call) => Response): { client: ApiClient; calls: Call[] } {
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
function channelHandler(overrides: Partial<Record<string, (call: Call) => Response>> = {}) {
  return (call: Call): Response => {
    if (call.url.includes('/work-items')) {
      return (overrides['convert'] ?? (() => json({}, 500)))(call);
    }
    if (call.url.includes('/revisions')) {
      return (overrides['revisions'] ?? (() => json({ revisions: [] })))(call);
    }
    if (call.url.includes('/messages')) {
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

describe('the channel list', () => {
  it('lists channels with their project and links into them', async () => {
    const { client } = clientOver((call) => {
      if (call.url.includes('/conversations')) return json({ conversations: [CONVERSATION] });
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

    const link = await screen.findByRole('link', { name: '#atlas-relaunch' });
    expect(link).toHaveAttribute('href', '/northstar/chat/conv-1');
    // The project name appears beside the channel row (it is also an option in two selects).
    const row = link.closest('li') as HTMLElement;
    expect(within(row).getByText('Atlas Website Relaunch')).toBeInTheDocument();
  });

  it('creates a channel on the chosen project', async () => {
    const { client, calls } = clientOver((call) => {
      if (call.url.includes('/conversations') && call.method === 'POST') {
        return json({ ...CONVERSATION, id: 'conv-2', name: 'general' }, 201);
      }
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
    // Two "Project" selects exist — the filter's and the form's. Scope to the form's section,
    // and wait for the projects query to fill its options before choosing one.
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
});

describe('TM-09 the convert dialog', () => {
  async function openDialog(client: ApiClient) {
    renderChannel(client);
    const list = await screen.findByRole('list', { name: 'Messages, oldest first' });
    const firstItem = within(list).getAllByRole('listitem')[0] as HTMLElement;
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
