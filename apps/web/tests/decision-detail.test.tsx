import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { DecisionDetailScreen } from '../src/components/screens/DecisionDetailScreen';
import { ApiClient } from '../src/lib/api/client';
import { decisionCode } from '../src/lib/api/decisions';
import { expectNoAxeViolations } from './axe';

/**
 * **A15 — the Decision detail page (Figma 384:3835).**
 *
 * The API's relation gate, the source-message check and the lock are proved in `apps/api`. Here:
 * the page draws the decision as designed (status pill, DEC number, why, source card, linked work,
 * details), the register column inks the decision on screen, and Edit PATCHes why and who sees it.
 */

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function clientOver(handler: (call: Call) => Response, calls: Call[]): ApiClient {
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const DECISION = {
  id: 'dec-14',
  projectId: 'proj-1',
  meetingId: null,
  title: 'Launch the mobile booking flow first; desktop follows two weeks later',
  statement: 'Mobile first.',
  status: 'accepted',
  decidedBy: 'user-omar',
  decidedAt: '2026-10-16T09:00:00.000Z',
  createdAt: '2026-10-16T09:00:00.000Z',
  number: 14,
  rationale: 'Most of the client’s bookings come from phones (72 %).',
  sourceMessageId: 'msg-1',
  audience: 'client_visible',
  supersededBy: null,
  supersedes: [],
  decidedByName: 'Omar Adel',
  source: {
    messageId: 'msg-1',
    conversationId: 'conv-1',
    channelName: 'atlas-relaunch',
    authorName: 'Salma Riad',
    quote: 'Can we also see the mobile booking flow before launch?',
    at: '2026-10-15T10:51:00.000Z',
  },
};

function handler(call: Call): Response {
  if (call.url.includes('/decisions/dec-14/work-links')) {
    return json({
      workLinks: [
        {
          linkId: 'link-1',
          decisionId: 'dec-14',
          workItemId: 'work-1',
          workItemTitle: 'Build the mobile booking flow',
          workItemState: 'in_progress',
          workItemOwnerName: 'Lina Samir',
          workItemDueAt: '2026-10-24T12:00:00.000Z',
          createdAt: '2026-10-16T09:00:00.000Z',
        },
      ],
    });
  }
  if (call.url.includes('/decisions/dec-14')) {
    if (call.method === 'PATCH') return json({ ...DECISION, rationale: 'Phones first.' });
    return json(DECISION);
  }
  if (call.url.includes('/decisions?projectId=proj-1')) {
    return json({
      decisions: [
        { ...DECISION, supersededBy: undefined },
        { ...DECISION, id: 'dec-13', title: 'Weekly status every Thursday', number: 13 },
      ],
    });
  }
  if (call.url.endsWith('/projects')) {
    return json({ projects: [{ id: 'proj-1', name: 'Atlas relaunch' }] });
  }
  return json({}, 404);
}

function page(calls: Call[]) {
  const query = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const tree: ReactNode = (
    <DecisionDetailScreen
      organizationSlug="acme"
      organizationName="Acme"
      decisionId="dec-14"
      client={clientOver(handler, calls)}
    />
  );
  return <QueryClientProvider client={query}>{tree}</QueryClientProvider>;
}

describe('DecisionDetailScreen', () => {
  it('draws the decision as designed', async () => {
    const { container } = render(page([]));
    expect(await screen.findByRole('heading', { level: 2, name: DECISION.title })).toBeVisible();
    expect(await screen.findByText('DEC-014 · Atlas relaunch')).toBeVisible();
    expect(screen.getByText(DECISION.rationale)).toBeVisible();
    expect(screen.getByText(`“${DECISION.source.quote}”`)).toBeVisible();
    expect(screen.getByRole('link', { name: /Open the message/ })).toHaveAttribute(
      'href',
      '/acme/chat/conv-1#message-msg-1',
    );
    const work = await screen.findByRole('link', { name: /Build the mobile booking flow/ });
    expect(within(work).getByText('Lina Samir · due 24 Oct')).toBeVisible();
    expect(within(work).getByText('In progress')).toBeVisible();

    const details = screen.getByRole('complementary', { name: 'Details' });
    expect(within(details).getByText('Omar Adel')).toBeVisible();
    expect(within(details).getByText('16 Oct 2026')).toBeVisible();
    expect(within(details).getByText('Team and client')).toBeVisible();
    expect(within(details).getByText('Decided')).toBeVisible();

    expect(await screen.findByRole('link', { name: 'Weekly status every Thursday' })).toBeVisible();
    expect(screen.getByRole('link', { name: DECISION.title })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expectNoAxeViolations(container);
  });

  it('Edit saves why we decided this and who can see it', async () => {
    const calls: Call[] = [];
    render(page(calls));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Edit decision' });
    const why = within(form).getByLabelText('Why we decided this');
    await user.clear(why);
    await user.type(why, 'Phones first.');
    await user.selectOptions(within(form).getByLabelText('Visible to'), 'internal');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      const patch = calls.find((call) => call.method === 'PATCH');
      expect(patch?.body).toEqual({ rationale: 'Phones first.', audience: 'internal' });
    });
  });

  it('prints the register number as DEC-014', () => {
    expect(decisionCode(14)).toBe('DEC-014');
    expect(decisionCode(1203)).toBe('DEC-1203');
    expect(decisionCode(null)).toBe('DEC-—');
  });
});
