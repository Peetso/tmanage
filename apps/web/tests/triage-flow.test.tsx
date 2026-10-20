import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { RequestInboxScreen } from '../src/components/screens/RequestInboxScreen';
import { RequestTriageScreen } from '../src/components/screens/RequestTriageScreen';
import { ApiClient } from '../src/lib/api/client';
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
      Promise.resolve(handler(String(input), init))) as typeof globalThis.fetch,
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
    version: 2,
    createdAt: '2026-08-12T09:20:00.000Z',
    updatedAt: '2026-08-12T09:20:00.000Z',
    ...overrides,
  };
}

function workItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wi-1',
    projectId: 'proj-1',
    type: 'task',
    title: 'Content migration',
    state: 'in_progress',
    ownerUserId: null,
    audience: 'internal',
    startAt: null,
    dueAt: '2026-09-08T00:00:00.000Z',
    version: 1,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    deletedAt: null,
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

describe('REQ-02 the triage screen', () => {
  function renderTriage(
    overrides: Record<string, unknown> = {},
    work: readonly unknown[] = [workItem()],
  ) {
    const sent: { url: string; body: unknown }[] = [];
    const current = record(overrides);
    const api = clientOver((url, init) => {
      if (init?.method === 'POST') {
        sent.push({ url, body: JSON.parse(String(init.body)) });
        if (url.includes('/acceptance')) {
          return json({
            request: { ...current, state: 'accepted', version: current.version + 1 },
            workItemId: 'wi-new',
            workItemCreated: true,
          });
        }
        const body = JSON.parse(String(init.body)) as { to: string };
        return json({ ...current, state: body.to, version: current.version + 1 });
      }
      if (url.includes('/work-items')) return json({ workItems: work });
      return json(current);
    });

    const view = render(
      withQuery(<RequestTriageScreen {...NAMES} clientRequestId="req-1" client={api} />),
    );
    return { view, sent };
  }

  it('says every outcome needs a reason the client can read', async () => {
    renderTriage();
    expect(
      await screen.findByText('Every outcome requires a reason the client can read.'),
    ).toBeInTheDocument();
    // Each control names its own cost, so the price of an outcome is visible before it is picked.
    expect(screen.getByRole('button', { name: 'Commit with a date' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask another question' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Defer with a reason' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Decline with a reason' })).toBeInTheDocument();
  });

  it('will not send a decline with an empty reason', async () => {
    const user = userEvent.setup();
    const { sent } = renderTriage();

    await user.click(await screen.findByRole('button', { name: 'Decline with a reason' }));
    expect(screen.getByRole('button', { name: 'Decline this request' })).toBeDisabled();
    expect(sent).toHaveLength(0);
  });

  it('sends the clarification question the client will read word for word', async () => {
    const user = userEvent.setup();
    const { sent } = renderTriage();

    await user.click(await screen.findByRole('button', { name: 'Ask another question' }));
    await user.type(
      screen.getByLabelText('What do you need to know?'),
      'How many questions should it cover?',
    );
    await user.click(screen.getByRole('button', { name: 'Ask the client' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body).toEqual({
      version: 2,
      to: 'needs_clarification',
      clarificationQuestion: 'How many questions should it cover?',
    });
  });

  it('offers only "start triaging" on a request nobody has opened', async () => {
    const user = userEvent.setup();
    const { sent } = renderTriage({ state: 'submitted' });

    // §6 routes every answer through `triage`. A manager should not discover that by refusal,
    // so the four outcomes are not offered until the request has actually been opened.
    const start = await screen.findByRole('button', { name: 'Start triaging' });
    expect(screen.queryByRole('button', { name: 'Commit with a date' })).not.toBeInTheDocument();

    await user.click(start);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body).toEqual({ version: 2, to: 'triage' });
  });

  it('offers only "the client has answered" while a clarification is outstanding', async () => {
    const user = userEvent.setup();
    const { sent } = renderTriage({
      state: 'needs_clarification',
      clarificationQuestion: 'Which markets does the autumn campaign cover?',
    });

    // The defect this pins: the screen used to treat `needs_clarification` as open and render
    // all four outcomes, but `23-ERD` §6 draws no edge from here to accepted, deferred or
    // declined — the API answered 422 for every one of them. A manager who asked a question
    // could never answer the request. §6's route back is through `triage`, and that is the
    // only control this state gets.
    const answered = await screen.findByRole('button', { name: 'The client has answered' });
    expect(screen.getByText('Waiting on the client')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Commit with a date' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Defer with a reason' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Decline with a reason' })).not.toBeInTheDocument();

    await user.click(answered);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body).toEqual({ version: 2, to: 'triage' });
  });

  it('says an answered request is answered rather than offering dead controls', async () => {
    renderTriage({ state: 'declined', clientVisibleReason: 'Outside the statement of work.' });
    expect(await screen.findByText('This request has been answered')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Commit with a date' })).not.toBeInTheDocument();
    expect(screen.getByText('Outside the statement of work.')).toBeInTheDocument();
  });

  it('has one h1 and no axe violation', async () => {
    const { view } = renderTriage();
    await screen.findByRole('button', { name: 'Commit with a date' });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    await expectNoAxeViolations(view.container);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('REQ-03 the commitment review', () => {
  function renderTriage(work: readonly unknown[] = [workItem()]) {
    const sent: { url: string; body: unknown }[] = [];
    const current = record();
    const api = clientOver((url, init) => {
      if (init?.method === 'POST') {
        sent.push({ url, body: JSON.parse(String(init.body)) });
        return json({
          request: { ...current, state: 'accepted', version: 3 },
          workItemId: 'wi-new',
          workItemCreated: true,
        });
      }
      if (url.includes('/work-items')) return json({ workItems: work });
      return json(current);
    });
    const view = render(
      withQuery(<RequestTriageScreen {...NAMES} clientRequestId="req-1" client={api} />),
    );
    return { view, sent };
  }

  async function compose(user: ReturnType<typeof userEvent.setup>, day: string) {
    await user.click(await screen.findByRole('button', { name: 'Commit with a date' }));
    await user.type(
      screen.getByLabelText('What are you agreeing to do?'),
      'FAQ, eight questions, Arabic and English.',
    );
    await user.type(screen.getByLabelText('Committed date'), day);
  }

  it('states the difference between the promised and the desired date', async () => {
    const user = userEvent.setup();
    renderTriage();
    await compose(user, '2026-09-10');

    // The artifact, in capitals: "10 SEP ≠ THEIR DESIRED 3 SEP · THE DIFFERENCE IS STATED, NOT
    // HIDDEN". Shown while the date can still be changed.
    expect(await screen.findByText('That is not the date they asked for')).toBeInTheDocument();
    expect(screen.getByText(/7 days later/)).toBeInTheDocument();
  });

  it('counts what else the project already owes that week, and says what the count is not', async () => {
    const user = userEvent.setup();
    renderTriage([workItem({ title: 'Content migration', dueAt: '2026-09-08T00:00:00.000Z' })]);
    await compose(user, '2026-09-10');

    // Scoped to the alert: the impact sentence and its wrapper both match a bare text query.
    const impact = await screen.findByText(/already due within three days/);
    expect(impact).toHaveTextContent('Content migration');
    // Named as what it is. Milestones and capacity do not exist, so nothing claims a collision.
    expect(impact).toHaveTextContent(/not a check of anybody's capacity/);
  });

  it('shows the sentence the client will read before anything is written', async () => {
    const user = userEvent.setup();
    const { sent } = renderTriage();
    await compose(user, '2026-09-10');
    await user.click(screen.getByRole('button', { name: 'Review the commitment' }));

    expect(
      await screen.findByText(/You are about to promise a date to Atlas Hospitality/),
    ).toBeInTheDocument();
    expect(screen.getByText('What the client will read')).toBeInTheDocument();
    expect(
      screen.getByText(/We have accepted this and committed to .*FAQ, eight questions/),
    ).toBeInTheDocument();
    // Nothing has been written yet. The review is a step, not a receipt.
    expect(sent).toHaveLength(0);
  });

  it('commits through the acceptance route, and reports what it did to the plan', async () => {
    const user = userEvent.setup();
    const { sent } = renderTriage();
    await compose(user, '2026-09-10');
    await user.click(screen.getByRole('button', { name: 'Review the commitment' }));
    await user.click(screen.getByRole('button', { name: 'Commit and tell the client' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.url).toContain('/acceptance');
    expect(sent[0]?.body).toEqual({
      version: 2,
      clientSafeScopeSummary: 'FAQ, eight questions, Arabic and English.',
      commitment: '2026-09-10',
    });

    // REQ-002 made the work and the acceptance one transaction; the screen says which happened
    // in plain English (CQ-07).
    expect(
      await screen.findByText('A work item was created for this request.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the work item' })).toHaveAttribute(
      'href',
      '/northstar/work/wi-new',
    );
  });

  it('lets a manager accept with no date, which §6 allows and silence is not', async () => {
    const user = userEvent.setup();
    const { sent } = renderTriage();

    await user.click(await screen.findByRole('button', { name: 'Commit with a date' }));
    await user.type(
      screen.getByLabelText('What are you agreeing to do?'),
      'The FAQ, scope agreed.',
    );
    await user.click(screen.getByLabelText(/Accept without a date yet/));
    await user.click(screen.getByRole('button', { name: 'Review the commitment' }));

    expect(await screen.findByText('No date yet, stated')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Commit and tell the client' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect((sent[0]?.body as { commitment: string }).commitment).toBe('unscheduled');
  });

  it('will not reach the review without both a scope and an answer to "when"', async () => {
    const user = userEvent.setup();
    renderTriage();
    await user.click(await screen.findByRole('button', { name: 'Commit with a date' }));

    // §6 requires both, and the machine would refuse. The screen refuses first, so a manager
    // is not sent to a review page for a commitment that cannot be made.
    expect(screen.getByRole('button', { name: 'Review the commitment' })).toBeDisabled();
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
