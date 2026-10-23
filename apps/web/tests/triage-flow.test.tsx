import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { RequestInboxScreen } from '../src/components/screens/RequestInboxScreen';
import { RequestTriageScreen } from '../src/components/screens/RequestTriageScreen';
import { ApiClient } from '../src/lib/api/client';
import { translate, type MessageKey } from '../src/lib/i18n/t';
import {
  describeAge,
  describeDateGap,
  previewClientSentence,
} from '../src/lib/triage-presentation';
import { expectNoAxeViolations } from './axe';

/**
 * `REQ-01 Request inbox`, `REQ-02 Request detail / triage` and `REQ-03 Commitment review` —
 * `WEB-005`, over the endpoints `REQ-001` and `REQ-002` delivered.
 *
 * What the API does is proved in `apps/api/test/req-001-client-requests.db.test.ts` against a
 * real MySQL: the lifecycle, the transaction, the one door onto `accepted`. Nothing here
 * re-proves any of it.
 *
 * What only this file can prove is what the studio's screens *say*:
 *
 * 1. **Every outcome names the reason it needs**, which is the artifact's own caption and the
 *    difference between a triage screen and a set of buttons.
 * 2. **Accepting is two steps**, and the second shows the sentence the client will read — built
 *    from the fields the API will store, so the preview cannot drift from the promise.
 * 3. **The date gap is stated, not hidden.** A manager promising a later date than the one asked
 *    for sees that in words while they can still change it.
 * 4. **The impact line is a fact or an absence.** Milestones do not exist, so what is shown is a
 *    count of dated work this system can actually check, labelled as exactly that.
 * 5. **The inbox counts what a manager opens it for**, and adds no rail item §1 does not list.
 */

function clientOver(handler: (url: string, init?: RequestInit) => Response): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
      // The request conversation (P8) has its own suite; here it is an empty thread.
      Promise.resolve(
        String(input).endsWith('/messages') && init?.method !== 'POST'
          ? json({ messages: [] })
          : handler(String(input), init),
      )) as typeof globalThis.fetch,
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

function withQuery(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const NOW = new Date('2026-08-14T09:20:00.000Z');

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: 'req-1',
    projectId: 'proj-1',
    clientOrganizationId: 'client-1',
    clientOrganizationName: 'Atlas Hospitality',
    submittedByUserId: 'user-1',
    title: 'Add Arabic booking FAQ before launch',
    category: 'new-page',
    description: 'Our Arabic guests ask the same booking questions by phone.',
    urgencyReason: null,
    desiredAt: '2026-09-03',
    state: 'triage',
    clarificationQuestion: null,
    clientVisibleReason: null,
    clientSafeScopeSummary: null,
    commitment: null,
    committedAt: null,
    linkedWorkItemId: null,
    submittedByName: null,
    deferUntil: null,
    remindOnReopen: false,
    version: 2,
    createdAt: '2026-08-12T09:20:00.000Z',
    updatedAt: '2026-08-12T09:20:00.000Z',
    ...overrides,
  };
}

const NAMES = { organizationSlug: 'northstar', organizationName: 'Northstar Studio' } as const;

// ─────────────────────────────────────────────────────────────────────────────

describe('REQ-01 the request inbox', () => {
  function renderInbox(rows: readonly unknown[]) {
    const api = clientOver(() => json({ clientRequests: rows }));
    return render(withQuery(<RequestInboxScreen {...NAMES} client={api} now={NOW} />));
  }

  it('counts what a manager opens it for', async () => {
    renderInbox([
      record({ id: 'a', state: 'submitted' }),
      record({ id: 'b', state: 'triage' }),
      record({ id: 'c', state: 'needs_clarification' }),
      record({ id: 'd', state: 'declined' }),
    ]);

    // The artifact leads with these counts. `submitted` and `triage` are one bucket: both are
    // the studio's to act on.
    expect(await screen.findByRole('button', { name: 'Needs triage · 2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clarifying · 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Declined · 1' })).toBeInTheDocument();
  });

  it('filters to one bucket without leaving the page', async () => {
    const user = userEvent.setup();
    renderInbox([
      record({ id: 'a', state: 'triage', title: 'Needs an answer' }),
      record({ id: 'b', state: 'declined', title: 'Already declined' }),
    ]);

    await user.click(await screen.findByRole('button', { name: 'Needs triage · 1' }));
    const table = screen.getByRole('table');
    expect(within(table).getByText('Needs an answer')).toBeInTheDocument();
    expect(within(table).queryByText('Already declined')).not.toBeInTheDocument();
  });

  it('names the client, which a manager cannot look up for themselves', async () => {
    renderInbox([record()]);
    // `GET client-organizations` is gated on `org.manage`, which a manager does not hold. The
    // API puts the name on the internal projection for exactly this row.
    expect(await screen.findByText('Atlas Hospitality')).toBeInTheDocument();
  });

  it('adds no rail destination that 22 §1 does not list', async () => {
    renderInbox([record()]);
    await screen.findByRole('table');

    const rail = screen.getAllByRole('navigation')[0]!;
    expect(within(rail).queryByRole('link', { name: /request/i })).not.toBeInTheDocument();
    expect(within(rail).getByRole('link', { name: 'Work' })).toBeInTheDocument();
  });

  it('invites nothing when there is nothing, because the client starts it', async () => {
    renderInbox([]);
    expect(await screen.findByText('No client has asked for anything yet')).toBeInTheDocument();
  });

  it('has one h1 and no axe violation', async () => {
    const view = renderInbox([record()]);
    await screen.findByRole('table');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    await expectNoAxeViolations(view.container);
  });

  it('pages on the cursor instead of silently showing the oldest 200', async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) =>
      record({ id: `req-${String(index).padStart(3, '0')}`, title: `Request ${index}` }),
    );
    const urls: string[] = [];
    const api = clientOver((url) => {
      urls.push(url);
      if (url.includes('after=')) {
        return json({ clientRequests: [record({ id: 'req-final', title: 'The 201st request' })] });
      }
      return json({ clientRequests: firstPage });
    });
    render(withQuery(<RequestInboxScreen {...NAMES} client={api} now={NOW} />));

    // A full page is announced as "loaded", never as the total.
    expect(await screen.findByText(/200 requests loaded — there are more/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByText(/201 requests in total/)).toBeInTheDocument();
    expect(urls.some((url) => url.includes('after=req-199'))).toBe(true);
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('A7 requests triage (fq9-triage, fq9-confirm-accept)', () => {
  const NOW_A7 = new Date('2026-10-27T09:00:00.000Z');
  const L = (key: string, vars: Record<string, string | number> = {}) => {
    let text = translate('en-US', key as MessageKey);
    for (const [name, value] of Object.entries(vars))
      text = text.split(`{${name}}`).join(String(value));
    return text;
  };

  const ROWS = [
    record({
      id: 'req-1',
      title: 'Add an Arabic version of the menu page',
      submittedByName: 'Youssef Adel',
      desiredAt: '2026-11-10',
      createdAt: '2026-10-27T07:00:00.000Z',
    }),
    record({
      id: 'req-2',
      title: 'Change the hero photo to the pool shot',
      submittedByName: 'Nadia Fawzy',
      state: 'submitted',
    }),
    record({
      id: 'req-3',
      title: 'Spring campaign ideas',
      submittedByName: 'Nadia Fawzy',
      state: 'deferred',
      deferUntil: '2026-11-03',
      remindOnReopen: true,
      version: 5,
    }),
    record({ id: 'req-4', title: 'Old logo files', state: 'accepted' }),
  ];

  function renderA7(selected = 'req-1') {
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    const api = clientOver((url, init) => {
      const byId = (id: string) => ROWS.find((row) => row.id === id) ?? ROWS[0];
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        sent.push({ url, body });
        const id = /client-requests\/([^/]+)\//.exec(url)?.[1] ?? 'req-1';
        const current = byId(id);
        if (url.endsWith('/messages')) {
          return json({
            id: 'm1',
            body: body['body'],
            authorKind: 'internal',
            clientVisible: true,
          });
        }
        if (url.endsWith('/acceptance')) {
          return json({
            request: { ...current, state: 'accepted', version: Number(current?.version) + 1 },
            workItemId: 'wi-new',
            workItemCreated: true,
          });
        }
        if (url.endsWith('/reopen')) {
          return json({ ...current, state: 'triage', deferUntil: null, version: 6 });
        }
        return json({ ...current, state: body['to'], version: Number(current?.version) + 1 });
      }
      if (url.includes('/client-requests?')) return json({ clientRequests: ROWS });
      const one = /client-requests\/([^/?]+)$/.exec(url);
      if (one?.[1]) return json(byId(one[1]));
      if (url.endsWith('/projects')) {
        return json({ projects: [{ id: 'proj-1', name: 'Website relaunch' }] });
      }
      if (url.includes('/members')) return json({ members: [] });
      return json({});
    });
    render(
      withQuery(
        <RequestTriageScreen {...NAMES} clientRequestId={selected} client={api} now={NOW_A7} />,
      ),
    );
    return { sent };
  }

  it('counts New and Deferred, and shows the deferred group with its return date', async () => {
    renderA7();
    expect(await screen.findByText('Spring campaign ideas')).toBeInTheDocument();
    const tabs = screen.getByRole('tablist');
    const newTab = within(tabs).getByRole('tab', { name: new RegExp(L('RequestTriageA7.tabNew')) });
    expect(newTab).toHaveAttribute('aria-selected', 'true');
    expect(newTab).toHaveTextContent('2');
    expect(
      within(tabs).getByRole('tab', { name: new RegExp(L('RequestTriageA7.tabDeferred')) }),
    ).toHaveTextContent('1');
    expect(
      screen.getByText(L('RequestTriageA7.backOn', { date: 'Tue 3 Nov' })),
    ).toBeInTheDocument();
    expect(screen.queryByText('Old logo files')).not.toBeInTheDocument();

    await userEvent.click(
      within(tabs).getByRole('tab', { name: new RegExp(L('RequestTriageA7.tabAccepted')) }),
    );
    const list = screen.getByRole('region', { name: L('RequestTriageA7.listLabel') });
    expect(await within(list).findByText('Old logo files')).toBeInTheDocument();
    expect(within(list).queryByText('Spring campaign ideas')).not.toBeInTheDocument();
  });

  it('defers until the chosen day and sends the reminder flag', async () => {
    const { sent } = renderA7();
    await screen.findByRole('heading', { name: 'Add an Arabic version of the menu page' });
    await userEvent.click(screen.getByRole('checkbox', { name: L('RequestTriageA7.remind') }));
    await userEvent.click(screen.getByRole('button', { name: L('RequestTriageA7.defer') }));
    await waitFor(() => expect(sent.some((call) => call.url.endsWith('/transitions'))).toBe(true));
    const move = sent.find((call) => call.url.endsWith('/transitions'));
    expect(move?.body).toMatchObject({
      to: 'deferred',
      version: 2,
      deferUntil: '2026-11-03',
      remindOnReopen: false,
    });
    expect(String(move?.body['clientVisibleReason'])).not.toBe('');
  });

  it('reopens a deferred request now, with the version it read', async () => {
    const { sent } = renderA7();
    await screen.findByText('Spring campaign ideas');
    await userEvent.click(screen.getByRole('button', { name: L('RequestTriageA7.reopenNow') }));
    await waitFor(() => expect(sent.some((call) => call.url.endsWith('/reopen'))).toBe(true));
    const call = sent.find((entry) => entry.url.endsWith('/reopen'));
    expect(call?.url).toContain('/client-requests/req-3/reopen');
    expect(call?.body).toEqual({ version: 5 });
  });

  it('confirms acceptance with the due date and the tell-the-client choice', async () => {
    const { sent } = renderA7();
    await screen.findByRole('heading', { name: 'Add an Arabic version of the menu page' });
    await userEvent.click(screen.getByRole('button', { name: L('RequestTriageA7.accept') }));
    const dialog = await screen.findByRole('dialog', { name: L('AcceptRequest.title') });
    expect(within(dialog).getByText('Website relaunch')).toBeInTheDocument();
    expect(within(dialog).getByText('Tue 10 Nov')).toBeInTheDocument();
    await userEvent.click(
      within(dialog).getByRole('checkbox', { name: L('AcceptRequest.tell', { name: 'Youssef' }) }),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: L('AcceptRequest.accept') }));
    await waitFor(() => expect(sent.some((call) => call.url.endsWith('/acceptance'))).toBe(true));
    expect(sent.find((call) => call.url.endsWith('/acceptance'))?.body).toEqual({
      version: 2,
      clientSafeScopeSummary: 'Add an Arabic version of the menu page',
      commitment: '2026-11-10',
      notifyClient: false,
    });
  });

  it('sends the team reply to the client on the request thread', async () => {
    const { sent } = renderA7();
    const box = await screen.findByRole('textbox', {
      name: L('RequestTriageA7.replyTo', { name: 'Youssef' }),
    });
    await userEvent.type(box, 'Thanks Youssef, we will confirm by Friday.');
    await userEvent.click(screen.getByRole('button', { name: L('RequestTriageA7.sendReply') }));
    await waitFor(() => expect(sent.some((call) => call.url.endsWith('/messages'))).toBe(true));
    expect(sent.find((call) => call.url.endsWith('/messages'))?.body).toMatchObject({
      body: 'Thanks Youssef, we will confirm by Friday.',
      clientVisible: true,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the triage vocabulary', () => {
  it('measures age in the shortest true unit', () => {
    const now = new Date('2026-08-14T09:20:00.000Z');
    expect(describeAge('2026-08-14T09:00:00.000Z', now)).toBe('20m');
    expect(describeAge('2026-08-14T04:20:00.000Z', now)).toBe('5h');
    expect(describeAge('2026-08-12T09:20:00.000Z', now)).toBe('2d');
  });

  it('says nothing about a gap that does not exist', () => {
    expect(describeDateGap('2026-09-03', '2026-09-03')).toBeNull();
    expect(describeDateGap(null, '2026-09-03')).toBeNull();
    expect(describeDateGap('2026-09-03', null)).toBeNull();
  });

  it('previews an unscheduled acceptance as an answer rather than an absence', () => {
    const sentence = previewClientSentence('The FAQ', { kind: 'unscheduled' });
    expect(sentence).toContain('We have accepted this');
    expect(sentence).toContain('not committed to a date yet');
  });
});
