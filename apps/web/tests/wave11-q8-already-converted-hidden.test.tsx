import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ProjectChannelScreen } from '../src/components/screens/ProjectChannelScreen';
import { ApiClient } from '../src/lib/api/client';
import en from '../src/lib/i18n/messages/en.json';

/**
 * Wave 11 Q8 (security run 3, N02 UX follow-up). The API answers one 409
 * `message_already_converted` when the message already became work the caller cannot open.
 * The convert alert must say that, not claim the message was removed; any other 409 keeps
 * the removed-message wording.
 */

const messages = en as Record<string, string>;
const ALREADY_CONVERTED_HIDDEN = messages['ProjectChannelScreen.alreadyConvertedHidden'] as string;
const REMOVED_CANNOT_CONVERT = messages['ProjectChannelScreen.removedCannotConvert'] as string;

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

const MESSAGE = {
  id: 'msg-1',
  conversationId: 'conv-1',
  authorUserId: 'user-aaaa-1111',
  sequenceNo: 1,
  parentMessageId: null,
  body: 'The homepage hero needs a rewrite.',
  bodyRich: null,
  editedAt: null,
  deletedAt: null,
  deletedByUserId: null,
  createdAt: '2026-08-27T10:00:00.000Z',
  updatedAt: '2026-08-27T10:00:00.000Z',
};

function clientWithConvertAnswer(convert: () => Response): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const answer = (): Response => {
        if (url.includes('/work-items')) return convert();
        if (url.includes('/revisions')) return json({ revisions: [] });
        if (/\/organizations\/northstar\/members/u.test(url)) return json({}, 404);
        if (url.includes('/reactions')) return json({ messageId: 'msg-1', reactions: [] });
        if (url.includes('/attachments')) return json({ attachments: [] });
        if (url.includes('/conversations/conv-1/members')) return json({ members: [] });
        if (url.includes('/conversations/directory')) return json({}, 404);
        if (url.includes('/messages')) {
          if (init?.method === undefined || init.method === 'GET') {
            if (url.includes('parentMessageId=')) return json({ messages: [] });
            return json({ messages: [MESSAGE] });
          }
          return json({}, 500);
        }
        if (url.includes('/realtime/tickets')) {
          return json(
            { ticket: 'tkt-1', expiresAt: '2026-08-30T00:01:00.000Z', socketUrl: null },
            201,
          );
        }
        if (url.includes('/conversations/conv-1')) return json(CONVERSATION);
        if (url.includes('/projects/proj-1')) return json(PROJECT);
        return json({}, 404);
      };
      return Promise.resolve(answer());
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
}

function conflict(details: readonly { field: string; message: string }[]): Response {
  return json(
    {
      error: {
        code: 'conflict',
        message: 'This message was already converted into work',
        correlationId: 'correlation-fixed',
        details,
      },
    },
    409,
  );
}

async function submitConvert(client: ApiClient): Promise<HTMLElement> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ProjectChannelScreen
        organizationSlug="northstar"
        organizationName="Northstar Studio"
        conversationId="conv-1"
        client={client}
      />
    </QueryClientProvider>,
  );
  const list = await screen.findByRole('list', { name: 'Messages, oldest first' });
  const firstItem = within(list).getAllByRole('listitem')[0] as HTMLElement;
  await userEvent.click(within(firstItem).getByRole('button', { name: 'More actions' }));
  await userEvent.click(within(firstItem).getByRole('button', { name: 'Create work from this' }));
  const form = await screen.findByRole('form', { name: 'Create work from this message' });
  await userEvent.click(within(form).getByRole('button', { name: 'Create work item' }));
  await within(form).findByText(en['ProjectChannelScreen.couldNotCreateWork']);
  return form;
}

describe('Q8 the convert alert for a message already converted into hidden work', () => {
  it('says the work exists but cannot be opened, not that the message was removed', async () => {
    expect(ALREADY_CONVERTED_HIDDEN.length).toBeGreaterThan(0);
    const form = await submitConvert(
      clientWithConvertAnswer(() =>
        conflict([{ field: 'messageId', message: 'message_already_converted' }]),
      ),
    );

    expect(within(form).getByText(new RegExp(escape(ALREADY_CONVERTED_HIDDEN), 'u'))).toBeTruthy();
    expect(within(form).queryByText(new RegExp(escape(REMOVED_CANNOT_CONVERT), 'u'))).toBeNull();
  });

  it('keeps the removed-message wording for any other 409', async () => {
    const form = await submitConvert(clientWithConvertAnswer(() => conflict([])));

    expect(within(form).getByText(new RegExp(escape(REMOVED_CANNOT_CONVERT), 'u'))).toBeTruthy();
    expect(within(form).queryByText(new RegExp(escape(ALREADY_CONVERTED_HIDDEN), 'u'))).toBeNull();
  });
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
