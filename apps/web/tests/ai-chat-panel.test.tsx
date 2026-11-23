import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import type { CardItem, CopilotChatView } from '../src/lib/api/ai-chat';
import type { AiCreditsView } from '../src/lib/api/ai-credits';
import { AiChatPanel } from '../src/components/ai-chat/AiChatPanel';
import { answerParts, parseTypedAmount } from '../src/components/ai-chat/ai-chat-model';
import { expectNoAxeViolations } from './axe';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

/** Plan 62-15 — the TManage AI panel (Figma 764:43270): one test per key state. */

const BASE = 'https://api.example.test/v1/organizations/northstar';

type Reply = { status: number; body: unknown } | 'offline';
type Route = Reply | ((body: unknown) => Reply);

function view(overrides: Partial<CopilotChatView>): CopilotChatView {
  return {
    state: 'answer',
    answer: null,
    navigation: null,
    domain: 'tasks',
    tier: 'low',
    ceilingCredits: null,
    stop: null,
    suggestedTier: null,
    truncated: false,
    withheldFigures: 0,
    toolCalls: [],
    chargedCredits: 2,
    card: null,
    undo: null,
    conversationId: '0b6f2a8e-0000-4000-8000-000000000001',
    retryAfterSeconds: null,
    file: null,
    ...overrides,
  };
}

const CREDITS: AiCreditsView = {
  periodStart: '2026-11-01',
  resetsOn: '2026-12-01',
  allowanceCredits: 2000,
  limitedBy: 'plan',
  raisedBySupport: false,
  packCreditsThisMonth: 0,
  usedCredits: 1240,
  heldCredits: 0,
  remainingCredits: 760,
  packBalanceCredits: 0,
  packs: [],
  memberShareCredits: 1000,
  openRequest: null,
  canRequestPack: true,
};

function item(overrides: Partial<CardItem>): CardItem {
  return {
    index: 0,
    opId: 'work_items.update',
    title: 'Change a task',
    sensitivity: 'none',
    subject: 'Homepage hero copy',
    changes: [{ field: 'dueDate', before: 'Fri 20 Nov', after: 'Mon 23 Nov' }],
    stepUp: false,
    typedAmount: false,
    amount: null,
    cannotBeUndone: false,
    approvalId: null,
    warnings: [],
    ...overrides,
  };
}

function mount(routes: Record<string, Route>, role = 'member') {
  const calls: { key: string; body: unknown; headers: Headers }[] = [];
  const api = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input)}`;
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ key, body, headers: new Headers(init?.headers) });
      const match = Object.keys(routes)
        .sort((a, b) => b.length - a.length)
        .find((route) => key === route);
      const route =
        match === undefined ? { status: 404, body: { code: 'not_found' } } : routes[match]!;
      const reply = typeof route === 'function' ? route(body) : route;
      if (reply === 'offline') return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve(
        new Response(JSON.stringify(reply.body), {
          status: reply.status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queries.setQueryData(
    ['shell', 'organizations'],
    [
      {
        id: 'o',
        slug: 'northstar',
        name: 'Northstar',
        audience: 'internal',
        role,
        clientOrganizationName: null,
      },
    ],
  );
  const result = render(
    <QueryClientProvider client={queries}>
      <AiChatPanel organizationSlug="northstar" client={api} onClose={() => {}} />
    </QueryClientProvider>,
  );
  return { ...result, calls };
}

const CHAT = `POST ${BASE}/copilot/chat`;
const CREDITS_ROUTE = `GET ${BASE}/ai/credits`;

function ask(text: string) {
  fireEvent.change(screen.getByLabelText('Message to TManage AI'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
}

describe('AI chat model', () => {
  it('reads every way a member types an amount', () => {
    expect(parseTypedAmount('18400')).toBe(18400);
    expect(parseTypedAmount('18,400')).toBe(18400);
    expect(parseTypedAmount('18,400.00')).toBe(18400);
    expect(parseTypedAmount('١٨٤٠٠')).toBe(18400);
    expect(parseTypedAmount('١٨٬٤٠٠٫٥')).toBe(18400.5);
    expect(parseTypedAmount('18.400,00')).toBeNull();
    expect(parseTypedAmount('abc')).toBeNull();
  });

  it('links only in-app paths, inside the workspace', () => {
    expect(
      answerParts('See [Website](/projects/p1) or [x](https://evil.test)', 'northstar'),
    ).toEqual([
      { kind: 'text', text: 'See ' },
      { kind: 'link', text: 'Website', href: '/northstar/projects/p1' },
      { kind: 'text', text: ' or [x](https://evil.test)' },
    ]);
  });
});

describe('AiChatPanel', () => {
  it('empty state: examples, free help, the header meter, and no axe violations', async () => {
    const { container } = mount({ [CREDITS_ROUTE]: { status: 200, body: CREDITS } });
    expect(screen.getByRole('heading', { name: 'What can I help with?' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /What’s late this week/ })).toBeTruthy();
    const meter = await screen.findByRole('meter', { name: 'AI credits this month' });
    expect(meter.getAttribute('aria-valuenow')).toBe('1240');
    expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', true);
    await expectNoAxeViolations(container);
  });

  it('answer: shows the text in the live log, what it read, and the receipt', async () => {
    const { calls } = mount({
      [CHAT]: {
        status: 200,
        body: view({ answer: 'Four tasks are late on [Website relaunch](/projects/p1).' }),
      },
    });
    ask('What is late?');
    const log = screen.getByRole('log');
    expect(await within(log).findAllByText('Website relaunch', { selector: 'a' })).toHaveLength(2);
    expect(within(log).getByRole('navigation', { name: 'What I read' })).toBeTruthy();
    expect(within(log).getByText('2 credits · Low')).toBeTruthy();
    expect(calls.find((call) => call.key === CHAT)?.body).toEqual({
      message: 'What is late?',
      conversationId: null,
    });
  });

  it('estimate: Continue sends the accepted tier back; nothing runs before', async () => {
    let turn = 0;
    const { calls } = mount({
      [CHAT]: () => {
        turn += 1;
        return turn === 1
          ? {
              status: 200,
              body: view({
                state: 'estimate',
                tier: 'medium_high',
                domain: 'clients',
                ceilingCredits: 120,
                chargedCredits: 0,
              }),
            }
          : {
              status: 200,
              body: view({
                answer: 'They differ in price.',
                tier: 'medium_high',
                chargedCredits: 64,
              }),
            };
      },
    });
    ask('Compare the proposals');
    expect(await screen.findByRole('heading', { name: 'This is a larger task' })).toBeTruthy();
    expect(screen.getByText('120 credits')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('They differ in price.')).toBeTruthy();
    const second = calls.filter((call) => call.key === CHAT)[1]?.body as { confirmed: unknown };
    expect(second.confirmed).toEqual({ tier: 'medium_high', domain: 'clients' });
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
  });

  it('credits used up: an owner can request more credits', async () => {
    const { calls } = mount({
      [CREDITS_ROUTE]: { status: 200, body: CREDITS },
      [CHAT]: {
        status: 200,
        body: view({ state: 'stopped', stop: 'workspace_credits_used', chargedCredits: 0 }),
      },
      [`POST ${BASE}/ai/credits/pack-requests`]: {
        status: 201,
        body: { id: 'r1', status: 'open', requestedAt: '2026-11-21T10:00:00Z' },
      },
    });
    await screen.findByRole('meter');
    ask('Compare hours');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('used all its AI credits');
    fireEvent.click(screen.getByRole('button', { name: 'Request more credits' }));
    await waitFor(() =>
      expect(calls.some((call) => call.key === `POST ${BASE}/ai/credits/pack-requests`)).toBe(true),
    );
  });

  it('offline: says nothing was charged and retries the same question', async () => {
    let turn = 0;
    mount({
      [CHAT]: () => {
        turn += 1;
        return turn === 1 ? 'offline' : { status: 200, body: view({ answer: 'Back again.' }) };
      },
    });
    ask('Hello');
    expect((await screen.findByRole('alert')).textContent).toContain('Nothing was charged');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Back again.')).toBeTruthy();
  });

  it('preview card: confirm runs the signed card, then Done offers Undo from the server field', async () => {
    const card = {
      taskId: 't1',
      token: 'signed-card',
      expiresAt: '2026-11-21T14:27:00Z',
      items: [
        item({ index: 0 }),
        item({ index: 1, subject: 'Navigation redesign' }),
        item({ index: 2, subject: 'Footer links' }),
      ],
    };
    const { calls } = mount({
      [CHAT]: { status: 200, body: view({ state: 'preview', card, chargedCredits: 3 }) },
      [`POST ${BASE}/copilot/chat/confirm`]: {
        status: 200,
        body: {
          taskId: 't1',
          items: [0, 1, 2].map((index) => ({ index, opId: 'work_items.update', outcome: 'done' })),
          undoUntil: '2026-11-21T14:32:00Z',
          cannotBeUndone: false,
        },
      },
      [`POST ${BASE}/copilot/chat/tasks/t1/undo`]: {
        status: 200,
        body: { taskId: 't1', state: 'undone', refundedCredits: 3 },
      },
    });
    ask('Move the design tasks');
    expect(await screen.findByRole('heading', { name: 'Change 3 items' })).toBeTruthy();
    expect(screen.queryByText('Footer links')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 more changes' }));
    expect(screen.getByText('Footer links')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm 3 changes' }));
    expect(await screen.findByText('Done · 3 changed')).toBeTruthy();
    expect(calls.find((call) => call.key.endsWith('/chat/confirm'))?.body).toEqual({
      card: 'signed-card',
      amounts: {},
    });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('Undone.')).toBeTruthy();
  });

  it('money card: refuses a wrong amount before sending, then sends amount and step-up', async () => {
    const card = {
      taskId: 't2',
      token: 'money-card',
      expiresAt: '2026-11-21T14:27:00Z',
      items: [
        item({
          opId: 'finance.client_invoices.issue',
          title: 'Issue invoice',
          subject: 'INV-0042',
          sensitivity: 'money',
          stepUp: true,
          typedAmount: true,
          amount: 18400,
          cannotBeUndone: true,
          changes: [{ field: 'status', before: 'draft', after: 'issued' }],
        }),
      ],
    };
    const { calls } = mount({
      [CHAT]: { status: 200, body: view({ state: 'preview', card }) },
      'POST https://api.example.test/v1/auth/reauth': {
        status: 200,
        body: { reauthToken: 'proof' },
      },
      [`POST ${BASE}/copilot/chat/confirm`]: {
        status: 200,
        body: {
          taskId: 't2',
          items: [{ index: 0, opId: 'x', outcome: 'done' }],
          undoUntil: null,
          cannotBeUndone: true,
        },
      },
    });
    ask('Issue invoice INV-0042');
    await screen.findByRole('heading', { name: 'Issue invoice: INV-0042' });
    expect(screen.getByText('This can’t be undone after you confirm.')).toBeTruthy();
    const password = screen.getByLabelText(/^Password/);
    expect(password.getAttribute('autocomplete')).toBe('current-password');
    fireEvent.change(screen.getByLabelText(/Type the amount to confirm/), {
      target: { value: '18,000' },
    });
    fireEvent.change(password, { target: { value: 'secret-pass' } });
    fireEvent.click(screen.getByRole('button', { name: 'Issue invoice' }));
    expect(await screen.findByText('This doesn’t match the amount on the card.')).toBeTruthy();
    expect(calls.some((call) => call.key.endsWith('/chat/confirm'))).toBe(false);

    fireEvent.change(screen.getByLabelText(/Type the amount to confirm/), {
      target: { value: '18,400.00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Issue invoice' }));
    expect(await screen.findByText('This can’t be undone.')).toBeTruthy();
    const confirm = calls.find((call) => call.key.endsWith('/chat/confirm'));
    expect(confirm?.body).toEqual({ card: 'money-card', amounts: { 0: 18400 } });
    expect(confirm?.headers.get('x-reauth-token')).toBe('proof');
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });
});

/** A 404 `ai_unavailable` as the API sends it (AI-TWO-WAYS). */
const unavailable = (reason: string): Reply => ({
  status: 404,
  body: {
    error: {
      code: 'ai_unavailable',
      message: 'TManage AI is not available in this workspace',
      correlationId: 'c',
      details: [{ field: 'reason', message: reason }],
    },
  },
});

describe('AiChatPanel: TManage AI unavailable says why (AI-TWO-WAYS)', () => {
  it('no key, owner: names the cause, not "Something went wrong", and keeps your own AI', async () => {
    mount({ [CHAT]: unavailable('no_key') }, 'owner');
    ask('What is late?');
    expect(await screen.findByText(/no AI key is set for test workspaces/)).toBeTruthy();
    expect(screen.queryByText('Something went wrong. Nothing was charged.')).toBeNull();
    expect(screen.getByRole('link', { name: 'Connect your AI' }).getAttribute('href')).toBe(
      '/northstar/settings/ai-assistant',
    );
  });

  it('switch off, owner: says where to turn it on and links there', async () => {
    mount({ [CHAT]: unavailable('ai_off') }, 'owner');
    ask('What is late?');
    expect(await screen.findByText(/TManage AI is off for this workspace/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open AI settings' }).getAttribute('href')).toBe(
      '/northstar/admin/ai',
    );
  });

  it('module off, owner: links to Modules', async () => {
    mount({ [CHAT]: unavailable('flag_off') }, 'owner');
    ask('What is late?');
    expect(await screen.findByText(/“AI copilot” module is off/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Modules' }).getAttribute('href')).toBe(
      '/northstar/admin/feature-flags',
    );
  });

  it('a member reads only that it is not here yet, never the cause or a fix link', async () => {
    mount({ [CHAT]: unavailable('no_key') }, 'member');
    ask('What is late?');
    expect(
      await screen.findByText(
        'TManage AI isn’t available in this workspace yet. Nothing was charged.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/AI key/)).toBeNull();
    expect(screen.queryByRole('link', { name: /Open/ })).toBeNull();
    expect(screen.getByRole('link', { name: 'Connect your AI' })).toBeTruthy();
  });
});

describe('AiChatPanel: past conversations (Figma 789:50401)', () => {
  it('the icon is named on focus, lists titles and dates, and reopens a conversation', async () => {
    const id = '0b6f2a8e-0000-4000-8000-000000000009';
    mount({
      [`GET ${BASE}/copilot/conversations`]: {
        status: 200,
        body: {
          retentionDays: 30,
          items: [
            {
              id,
              title: 'Compare the three Cedar Foods proposals',
              createdAt: '2026-11-18T09:00:00Z',
              lastMessageAt: '2026-11-18T09:05:00Z',
            },
          ],
        },
      },
      [`GET ${BASE}/copilot/conversations/${id}`]: {
        status: 200,
        body: {
          conversation: {
            id,
            title: 'Compare the three Cedar Foods proposals',
            createdAt: '2026-11-18T09:00:00Z',
            lastMessageAt: '2026-11-18T09:05:00Z',
          },
          messages: [
            {
              id: 'm1',
              role: 'member',
              body: 'Compare the three Cedar Foods proposals',
              taskId: null,
              createdAt: '2026-11-18T09:00:00Z',
            },
            {
              id: 'm2',
              role: 'assistant',
              body: 'The second proposal is the cheapest.',
              taskId: null,
              createdAt: '2026-11-18T09:05:00Z',
            },
          ],
        },
      },
    });
    const button = screen.getByRole('button', { name: 'Past conversations' });
    fireEvent.focus(button);
    const tipId = button.getAttribute('aria-describedby')!.split(' ').at(-1)!;
    const tip = document.getElementById(tipId)!;
    expect([tip.getAttribute('role'), tip.textContent]).toEqual(['tooltip', 'Past conversations']);

    fireEvent.click(button);
    const row = await screen.findByRole('button', {
      name: /^Compare the three Cedar Foods proposals/,
    });
    expect(row.textContent).toMatch(/Compare the three Cedar Foods proposals.+\S/);
    expect(row.textContent!.length).toBeGreaterThan(
      'Compare the three Cedar Foods proposals'.length,
    );
    fireEvent.click(row);
    expect(await screen.findByText('The second proposal is the cheapest.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'TManage AI' })).toBeTruthy();
  });
});
