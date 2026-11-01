import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  RecordDecisionDialog,
  recordedDecisionHref,
  titleFromMessage,
} from '../src/components/decisions/RecordDecisionDialog';
import { MessageActionsSheet } from '../src/components/chat/MessageActionsSheet';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * F3 — Record as decision from a chat message (Figma 390:5808). The API's own rules — a direct
 * message only of a participant, an active "Decided by" — are proved in `apps/api`
 * (`decisions.service.test.ts`). Here: the dialog's prefill and the create body it sends, the
 * direct message's actions menu, and the phone sheet's item.
 */

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

const BODY = 'Agreed: we launch the mobile booking flow first. Desktop follows two weeks later.';
const NOW = new Date('2026-10-25T10:00:00.000Z');

const DECISION = {
  id: 'dec-14',
  projectId: 'proj-1',
  meetingId: null,
  title: 'We launch the mobile booking flow first',
  statement: BODY,
  status: 'accepted',
  decidedBy: 'user-omar',
  decidedAt: NOW.toISOString(),
  createdAt: NOW.toISOString(),
  number: 14,
  rationale: null,
  sourceMessageId: 'm-3',
  audience: 'internal',
};

function handler(call: Call): Response {
  if (call.method === 'POST' && call.url.endsWith('/decisions')) return json(DECISION, 201);
  if (call.url.includes('/projects/proj-1/members')) {
    return json({
      members: [
        { projectMembershipId: 'pm-1', userId: 'user-omar', role: 'lead', createdAt: '' },
        { projectMembershipId: 'pm-2', userId: 'user-lina', role: 'member', createdAt: '' },
      ],
    });
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
  if (call.url.endsWith('/projects')) {
    return json({ projects: [{ id: 'proj-1', name: 'Atlas relaunch', status: 'active' }] });
  }
  if (call.url.includes('/read-state')) {
    return json({
      directConversationId: 'dm-lina',
      lastSequenceNo: 3,
      lastReadSequenceNo: 3,
      unreadCount: 0,
    });
  }
  if (call.url.includes('/direct-conversations/dm-lina/messages')) {
    return json({
      messages: [
        {
          id: 'm-2',
          directConversationId: 'dm-lina',
          authorUserId: 'user-omar',
          sequenceNo: 2,
          body: 'Sure. Send me the frames.',
          createdAt: '2026-10-25T09:14:00.000Z',
        },
        {
          id: 'm-3',
          directConversationId: 'dm-lina',
          authorUserId: 'user-lina',
          sequenceNo: 3,
          body: BODY,
          createdAt: '2026-10-25T09:15:00.000Z',
        },
      ],
    });
  }
  if (call.url.includes('/direct-conversations')) {
    return json({
      conversations: [
        {
          id: 'dm-lina',
          otherUserId: 'user-lina',
          otherDisplayName: 'Lina Samir',
          lastMessageAt: null,
          createdAt: '2026-10-23T08:00:00.000Z',
          lastSequenceNo: 3,
          lastReadSequenceNo: 3,
          unreadCount: 0,
        },
      ],
    });
  }
  return json({}, 404);
}

function clientOver(calls: Call[]): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call = {
        url: String(input),
        method: (init?.method ?? 'GET').toUpperCase(),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      return Promise.resolve(handler(call));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
}

function wrap(children: ReactNode) {
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={queries}>{children}</QueryClientProvider>;
}

const MESSAGE = {
  id: 'm-3',
  body: BODY,
  authorName: 'Lina Samir',
  createdAt: '2026-10-25T09:15:00.000Z',
};

describe('titleFromMessage', () => {
  it('takes the first sentence without its lead-in label', () => {
    expect(titleFromMessage(BODY)).toBe('We launch the mobile booking flow first');
    expect(titleFromMessage('Ship it on Friday')).toBe('Ship it on Friday');
    expect(titleFromMessage('x'.repeat(200))).toHaveLength(120);
  });

  it('opens the decision page with the recorded flag', () => {
    expect(recordedDecisionHref('acme', 'dec-14')).toBe('/acme/decisions/dec-14?recorded=1');
  });
});

describe('RecordDecisionDialog', () => {
  it('is filled in from the message and records it, linked, as decided', async () => {
    const calls: Call[] = [];
    const onRecorded = vi.fn();
    const { container } = render(
      wrap(
        <RecordDecisionDialog
          api={clientOver(calls)}
          organizationSlug="acme"
          message={MESSAGE}
          defaultProjectId="proj-1"
          selfUserId="user-omar"
          now={NOW}
          onRecorded={onRecorded}
          onClose={() => {}}
        />,
      ),
    );
    const dialog = screen.getByRole('dialog', { name: 'Record as decision' });
    expect(within(dialog).getByLabelText(/^Title/)).toHaveValue(
      'We launch the mobile booking flow first',
    );
    expect(within(dialog).getByLabelText('Decision')).toHaveValue(BODY);
    expect(within(dialog).getByLabelText('Link to the message')).toBeChecked();
    expect(await within(dialog).findByRole('option', { name: 'Omar Adel' })).toBeInTheDocument();
    expect(within(dialog).getByText(/The decision shows Lina Samir’s message from/)).toBeVisible();

    await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Save decision' }));
    await waitFor(() => expect(onRecorded).toHaveBeenCalled());
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.body).toEqual({
      projectId: 'proj-1',
      title: 'We launch the mobile booking flow first',
      statement: BODY,
      status: 'accepted',
      audience: 'internal',
      sourceMessageId: 'm-3',
    });
    await expectNoAxeViolations(container);
  });

  it('sends another decider, the audience, and no source when unlinked', async () => {
    const calls: Call[] = [];
    render(
      wrap(
        <RecordDecisionDialog
          api={clientOver(calls)}
          organizationSlug="acme"
          message={MESSAGE}
          defaultProjectId="proj-1"
          selfUserId="user-omar"
          now={NOW}
          onRecorded={() => {}}
          onClose={() => {}}
        />,
      ),
    );
    const user = userEvent.setup();
    const dialog = screen.getByRole('dialog', { name: 'Record as decision' });
    await within(dialog).findByRole('option', { name: 'Lina Samir' });
    await user.selectOptions(within(dialog).getByLabelText(/Decided by/), 'user-lina');
    await user.selectOptions(within(dialog).getByLabelText(/Visible to/), 'client_visible');
    await user.click(within(dialog).getByLabelText('Link to the message'));
    await user.click(within(dialog).getByRole('button', { name: 'Save decision' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.body).toMatchObject({ decidedBy: 'user-lina', audience: 'client_visible' });
    expect(post?.body).not.toHaveProperty('sourceMessageId');
  });

  it('refuses an empty title without a write', async () => {
    const calls: Call[] = [];
    render(
      wrap(
        <RecordDecisionDialog
          api={clientOver(calls)}
          organizationSlug="acme"
          message={MESSAGE}
          defaultProjectId="proj-1"
          now={NOW}
          onRecorded={() => {}}
          onClose={() => {}}
        />,
      ),
    );
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText(/^Title/));
    await user.click(screen.getByRole('button', { name: 'Save decision' }));
    expect(await screen.findByText('Give the decision a title.')).toBeVisible();
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });
});

describe('the phone actions sheet', () => {
  it('lists Record as decision after Reply in thread', async () => {
    const onRecordDecision = vi.fn();
    render(
      <MessageActionsSheet
        reacted={new Set()}
        onReact={() => {}}
        onMoreReactions={() => {}}
        onReply={() => {}}
        onRecordDecision={onRecordDecision}
        onClose={() => {}}
      />,
    );
    const items = screen.getAllByRole('button').map((button) => button.textContent ?? '');
    const reply = items.findIndex((text) => text.includes('Reply in thread'));
    expect(items[reply + 1]).toContain('Record as decision');
    await userEvent.setup().click(screen.getByRole('button', { name: /Record as decision/ }));
    expect(onRecordDecision).toHaveBeenCalled();
  });
});
