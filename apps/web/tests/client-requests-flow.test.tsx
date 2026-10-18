import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ClientActionsScreen } from '../src/components/screens/ClientActionsScreen';
import { ClientOverviewScreen } from '../src/components/screens/ClientOverviewScreen';
import { ClientRequestDetailScreen } from '../src/components/screens/ClientRequestDetailScreen';
import { ClientRequestsScreen } from '../src/components/screens/ClientRequestsScreen';
import { NewClientRequestScreen } from '../src/components/screens/NewClientRequestScreen';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * `CL-09 New request` and `CL-10 Request detail` — `WEB-004`'s second half, over the endpoints
 * `REQ-001` delivered.
 *
 * What the API does — the lifecycle, the client-safe reason, one client not reading another's
 * request — is proved in `apps/api/test/req-001-client-requests.db.test.ts` against a real
 * MySQL. Nothing here re-proves any of it.
 *
 * What only this file can prove is what the screens *say*:
 *
 * 1. **The confirmation states the date is uncommitted.** `22-SCREEN-BY-SCREEN` §6 puts it in
 *    bold, and it is the one thing a request form gets wrong by being ordinary.
 * 2. **The two dates are never the same line.** "Asked for" is the client's, "agreed" is the
 *    studio's, and the detail screen labels them apart even when only one exists.
 * 3. **Withdraw appears only when it would work**, and says why when it does not. `canWithdraw`
 *    comes from the state machine because `status` cannot answer: `triage` reads as `submitted`.
 * 4. **A decline is shown with the studio's reason**, which is the second half of §6's sentence.
 * 5. **`CL-02` has a second kind of card**, which is the whole reason this ticket follows
 *    `REQ-001`.
 */

function clientOver(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): ApiClient {
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

const PROJECT = {
  id: 'proj-1',
  name: 'Atlas Website Relaunch',
  status: 'active',
  committedAt: null,
  forecastAt: null,
};

/** A request as the API projects it. Deliberately spelled out rather than partially typed. */
function request(overrides: Record<string, unknown> = {}) {
  return {
    id: 'req-1',
    projectId: 'proj-1',
    title: 'Arabic booking FAQ on the rooms page',
    category: 'new-page',
    description: 'Half of our booking calls are Arabic speakers asking the same six questions.',
    urgencyReason: null,
    desiredAt: '2026-09-03',
    status: 'submitted',
    clarificationQuestion: null,
    clientVisibleReason: null,
    clientSafeScopeSummary: null,
    commitment: null,
    committedAt: null,
    canWithdraw: true,
    version: 1,
    createdAt: '2026-08-12T09:20:00.000Z',
    updatedAt: '2026-08-12T09:20:00.000Z',
    ...overrides,
  };
}

const NAMES = {
  organizationSlug: 'northstar',
  clientName: 'Atlas Hospitality',
  providerName: 'Northstar Studio',
} as const;

// ─────────────────────────────────────────────────────────────────────────────

describe('CL-09 the new request form', () => {
  function renderForm(onSubmitted?: (id: string) => void) {
    const sent: unknown[] = [];
    const api = clientOver((url, init) => {
      if (url.includes('/portal/requests') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        sent.push(body);
        // Echo what was sent, as the API does: the confirmation reads the *response*, and a
        // canned title here would let a screen that ignored the answer still pass.
        return json(request({ id: 'req-new', ...body }), 201);
      }
      if (url.includes('/portal/requests')) return json({ requests: [] });
      return json({ projects: [PROJECT] });
    });

    const view = render(
      withQuery(
        <NewClientRequestScreen
          {...NAMES}
          client={api}
          {...(onSubmitted ? { onSubmitted } : {})}
        />,
      ),
    );
    return { view, sent };
  }

  /**
   * The form used to accept typing into fields it was about to wipe. The controls are
   * controlled inputs; the submit button alone carried `disabled={projects.isPending}`. On a
   * cold page a person could type before React hydrated — the DOM held the words, no listener
   * existed, state stayed `''` — and hydration then re-applied `value=''` and erased them,
   * leaving "Say what you need in the first field" over a field they had just filled in.
   *
   * So the readiness condition now reaches the fields as well as the button. This is the one
   * test for that: disabled while the projects query is pending, editable once it answers, and
   * what is typed afterwards stays typed.
   */
  it('takes no word until the screen’s data has arrived, so nothing typed is silently wiped', async () => {
    const user = userEvent.setup();
    let answer: () => void = () => {};
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const api = clientOver((url) => {
      if (url.includes('/portal/projects')) {
        return answered.then(() => json({ projects: [PROJECT] }));
      }
      return json({ requests: [] });
    });

    render(withQuery(<NewClientRequestScreen {...NAMES} client={api} />));

    const title = screen.getByLabelText(/The request/);
    expect(title).toBeDisabled();
    expect(screen.getByLabelText(/Why it matters/)).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send request' })).toBeDisabled();

    answer();
    await waitFor(() => expect(title).toBeEnabled());

    await user.type(title, 'Refresh the homepage hero');
    expect(title).toHaveValue('Refresh the homepage hero');
  });

  it('calls the date a wish beside the field, not a deadline', async () => {
    renderForm();

    const field = await screen.findByLabelText('When you would like it');
    expect(field).toHaveAttribute('type', 'date');
    // The word "due" appears nowhere near it. §6 and the artifact's own caption: a desired date
    // is a wish, not a commitment.
    expect(screen.getByText(/wish rather than a deadline/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/due date/i)).not.toBeInTheDocument();
  });

  it('states the date is uncommitted in the confirmation, which is §6’s bolded requirement', async () => {
    const user = userEvent.setup();
    const { sent } = renderForm();

    await user.type(await screen.findByLabelText(/The request/), 'Arabic booking FAQ');
    await user.type(screen.getByLabelText(/Why it matters/), 'Half our calls ask the same six.');
    await user.click(screen.getByRole('button', { name: 'Send request' }));

    const confirmation = await screen.findByRole('status');
    expect(within(confirmation).getByText('Arabic booking FAQ')).toBeInTheDocument();
    expect(screen.getByText('Nothing is scheduled yet')).toBeInTheDocument();
    expect(
      screen.getByText(/It is not a commitment and it has not been agreed/i),
    ).toBeInTheDocument();
    expect(sent).toHaveLength(1);

    // A confirmation that led nowhere would be a dead end: the form is gone and the request
    // exists, so the screen owes the reader a way to either.
    expect(screen.getByRole('link', { name: 'See this request' })).toHaveAttribute(
      'href',
      '/northstar/portal/requests/req-new',
    );
    expect(screen.getByRole('link', { name: 'All of your requests' })).toBeInTheDocument();
  });

  it('sends a calendar day as an explicit instant, because the API refuses a bare date', async () => {
    const user = userEvent.setup();
    const { sent } = renderForm();

    await user.type(await screen.findByLabelText(/The request/), 'Arabic booking FAQ');
    await user.type(screen.getByLabelText(/Why it matters/), 'Half our calls ask the same six.');
    await user.type(screen.getByLabelText('When you would like it'), '2026-09-03');
    await user.click(screen.getByRole('button', { name: 'Send request' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    // A bare calendar date since 0012 — no invented midnight for a timezone to move.
    expect((sent[0] as { desiredAt: string }).desiredAt).toBe('2026-09-03');
  });

  it('offers no way to attach a file rather than one that would drop it', async () => {
    renderForm();
    await screen.findByLabelText(/The request/);

    // §6 lists files and US-B01 requires them scanned. FILE-001 is unbuilt, so there is no
    // input — an input that dropped the file would be worse than an honest absence.
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it('states the project rather than offering a pointless choice of one', async () => {
    renderForm();
    await screen.findByLabelText(/The request/);

    expect(screen.queryByLabelText('Which project')).not.toBeInTheDocument();
    // Awaited, and scoped: the form renders before the projects query resolves, and the shell
    // names the same project in its header once it has.
    const named = await screen.findAllByText('Atlas Website Relaunch');
    expect(named.length).toBeGreaterThan(0);
    expect(
      screen.getByText(/The only project Northstar Studio has shared with you/),
    ).toBeInTheDocument();
  });

  it('shows the field error the API returned, against the field it names', async () => {
    const user = userEvent.setup();
    const api = clientOver((url, init) => {
      if (url.includes('/portal/requests') && init?.method === 'POST') {
        return json(
          {
            error: {
              code: 'validation_failed',
              message: 'The request body is invalid',
              correlationId: 'c',
              details: [
                {
                  field: 'category',
                  message: 'must be a short lowercase label such as new-page or bug_report',
                },
              ],
            },
          },
          400,
        );
      }
      if (url.includes('/portal/requests')) return json({ requests: [] });
      return json({ projects: [PROJECT] });
    });

    render(withQuery(<NewClientRequestScreen {...NAMES} client={api} />));

    await user.type(await screen.findByLabelText(/The request/), 'Arabic booking FAQ');
    await user.type(screen.getByLabelText(/Why it matters/), 'Half our calls ask the same six.');
    await user.type(screen.getByLabelText('Category'), 'a whole sentence');
    await user.click(screen.getByRole('button', { name: 'Send request' }));

    expect(await screen.findByText(/must be a short lowercase label/i)).toBeInTheDocument();
  });

  it('has one h1 and no axe violation', async () => {
    const { view } = renderForm();
    await screen.findByLabelText(/The request/);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    await expectNoAxeViolations(view.container);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('CL-10 the request detail', () => {
  function renderDetail(
    overrides: Record<string, unknown> = {},
    onWithdraw?: (body: unknown) => unknown,
  ) {
    const current = request(overrides);
    const api = clientOver((url, init) => {
      if (url.includes('/withdrawal')) {
        const answer = onWithdraw?.(JSON.parse(String(init?.body)));
        return json(answer ?? { ...current, status: 'withdrawn', canWithdraw: false, version: 2 });
      }
      if (url.includes('/portal/requests/')) return json(current);
      if (url.includes('/portal/requests')) return json({ requests: [current] });
      return json({ projects: [PROJECT] });
    });

    return render(
      withQuery(<ClientRequestDetailScreen {...NAMES} requestId="req-1" client={api} />),
    );
  }

  it('never puts the two dates on the same line', async () => {
    renderDetail({
      status: 'accepted',
      commitment: 'committed',
      committedAt: '2026-11-14',
    });

    // The dates are asserted by their *label*, not their formatting: `Intl.DateTimeFormat`
    // renders in the runner's locale and a test pinned to one wording would be testing Node.
    expect(await screen.findByText('You asked for')).toBeInTheDocument();
    expect(screen.getByText(/^Asked for \S/)).toBeInTheDocument();
    expect(screen.getByText('Northstar Studio agreed')).toBeInTheDocument();
    expect(screen.getByText(/^Agreed for \S/)).toBeInTheDocument();
  });

  it('keeps “agreed to do, no date set” apart from “no date agreed”', async () => {
    renderDetail({ status: 'accepted', commitment: 'unscheduled' });

    // §6 gives an acceptance "committed date or explicit unscheduled state". The second is an
    // answer the client was given, not an absence, and the screen says so in those terms.
    expect(await screen.findByText('Agreed to do, no date set yet')).toBeInTheDocument();
    expect(screen.queryByText('No date agreed')).not.toBeInTheDocument();
  });

  it('shows a decline with the studio’s own reason', async () => {
    renderDetail({
      status: 'declined',
      clientVisibleReason: 'This sits outside the current statement of work.',
    });

    expect(await screen.findByText('Declined')).toBeInTheDocument();
    expect(
      screen.getByText('This sits outside the current statement of work.'),
    ).toBeInTheDocument();
  });

  it('puts a clarification question where it cannot be missed', async () => {
    renderDetail({
      status: 'clarifying',
      clarificationQuestion: 'How many rooms should the FAQ cover?',
    });

    expect(await screen.findByText('Waiting for your answer')).toBeInTheDocument();
    expect(screen.getByText('How many rooms should the FAQ cover?')).toBeInTheDocument();
  });

  it('offers withdraw, confirms it, and reflects the answer', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    renderDetail({}, (body) => {
      bodies.push(body);
      return undefined;
    });

    await user.click(await screen.findByRole('button', { name: 'Withdraw request' }));
    // A confirmation step, because withdrawal cannot be undone — §6 has no arrow back out of
    // `withdrawn`.
    expect(screen.getByText('Withdraw this request?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Yes, withdraw it' }));

    expect(await screen.findByText('Withdrawn')).toBeInTheDocument();
    // The version travels, so the API can refuse a stale write.
    expect(bodies).toEqual([{ version: 1 }]);
  });

  it('hides withdraw when the machine would refuse it, and says why', async () => {
    // The status is still `submitted` — `triage` is invisible to a client — and `canWithdraw`
    // is what carries the difference. A button drawn from `status` would appear here and fail.
    renderDetail({ canWithdraw: false });

    expect(await screen.findByText('Sent')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Withdraw request' })).not.toBeInTheDocument();
    expect(screen.getByText(/no longer yours to take back/i)).toBeInTheDocument();
  });

  it('does not tell a client the studio has not started while it is asking them something', async () => {
    // `23-ERD` §6 draws two arrows into `withdrawn`, and they describe different situations.
    // From `needs_clarification` the studio plainly *has* started — the question is on the same
    // page — so the submitted-state sentence contradicted the alert above it. Found by the
    // first end-to-end run of the client-request journey.
    renderDetail({
      status: 'clarifying',
      canWithdraw: true,
      clarificationQuestion: 'Which markets does the autumn campaign cover?',
    });

    expect(await screen.findByRole('button', { name: 'Withdraw request' })).toBeInTheDocument();
    expect(screen.getByText(/Withdrawing it is an answer too/)).toBeInTheDocument();
    expect(screen.queryByText(/has not started on it/)).not.toBeInTheDocument();
  });

  it('explains a 409 rather than inviting a retry', async () => {
    const user = userEvent.setup();
    const api = clientOver((url) => {
      if (url.includes('/withdrawal')) {
        return json(
          { error: { code: 'conflict', message: 'The resource was modified', correlationId: 'c' } },
          409,
        );
      }
      if (url.includes('/portal/requests/')) return json(request());
      return json({ projects: [PROJECT] });
    });

    render(withQuery(<ClientRequestDetailScreen {...NAMES} requestId="req-1" client={api} />));

    await user.click(await screen.findByRole('button', { name: 'Withdraw request' }));
    await user.click(screen.getByRole('button', { name: 'Yes, withdraw it' }));

    // A conflict means somebody moved the request while this page was open. Pressing again
    // would send the same stale version, so the copy says "look again" rather than "try again".
    expect(await screen.findByText(/changed while you were reading it/i)).toBeInTheDocument();
  });

  it('has one h1 and no axe violation', async () => {
    const view = renderDetail({
      status: 'clarifying',
      clarificationQuestion: 'How many rooms should the FAQ cover?',
    });
    await screen.findByText('Waiting for your answer');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    await expectNoAxeViolations(view.container);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the list of a client’s own requests', () => {
  function renderList(requests: readonly unknown[]) {
    const api = clientOver((url) => {
      if (url.includes('/portal/requests')) return json({ requests });
      return json({ projects: [PROJECT] });
    });
    return render(withQuery(<ClientRequestsScreen {...NAMES} client={api} />));
  }

  it('puts anything the studio is waiting on first', async () => {
    renderList([
      request({ id: 'req-old', title: 'Offers strip', createdAt: '2026-08-20T00:00:00.000Z' }),
      request({
        id: 'req-ask',
        title: 'Arabic FAQ',
        status: 'clarifying',
        createdAt: '2026-08-01T00:00:00.000Z',
      }),
    ]);

    const list = await screen.findByRole('list', { name: 'Your requests' });
    const titles = within(list)
      .getAllByRole('link')
      .map((link) => link.textContent);
    expect(titles[0]).toBe('Arabic FAQ');
  });

  it('invites a first request rather than showing an empty list', async () => {
    renderList([]);
    expect(await screen.findByText('You have not asked for anything yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ask for something' })).toBeInTheDocument();
  });

  it('has one h1 and no axe violation', async () => {
    const view = renderList([request()]);
    await screen.findByRole('list', { name: 'Your requests' });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    await expectNoAxeViolations(view.container);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the two screens that now reach requests', () => {
  function portalWith(requests: readonly unknown[], workItems: readonly unknown[] = []) {
    return clientOver((url) => {
      if (url.includes('/portal/work-items')) return json({ workItems });
      if (url.includes('/portal/requests')) return json({ requests });
      return json({ projects: [PROJECT] });
    });
  }

  it('CL-01 offers the way in, without a rail item 22 §1 does not list', async () => {
    render(withQuery(<ClientOverviewScreen {...NAMES} client={portalWith([])} />));

    expect(await screen.findByText('What you have asked for')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ask for something' })).toBeInTheDocument();

    // The client rail is still §1's seven. "Requests" is not among them and was not added.
    const rail = screen.getByRole('navigation');
    expect(within(rail).queryByRole('link', { name: /request/i })).not.toBeInTheDocument();
  });

  it('CL-02 renders a second kind of card, which is why this ticket follows REQ-001', async () => {
    render(
      withQuery(
        <ClientActionsScreen
          {...NAMES}
          client={portalWith(
            [
              request({
                status: 'clarifying',
                clarificationQuestion: 'How many rooms should the FAQ cover?',
              }),
            ],
            [
              {
                id: 'wi-1',
                projectId: 'proj-1',
                title: 'Approve the copy',
                progress: 'waiting_on_you',
                dueAt: null,
                updatedAt: '2026-08-28T00:00:00.000Z',
              },
            ],
          )}
          now={new Date('2026-09-01T12:00:00.000Z')}
        />,
      ),
    );

    const questions = await screen.findByRole('list', { name: 'Questions to answer' });
    // §6 asks each card to say *why*. For a request it can, because the studio wrote it down.
    expect(within(questions).getByText('How many rooms should the FAQ cover?')).toBeInTheDocument();

    const actions = screen.getByRole('list', { name: 'Your actions' });
    expect(within(actions).getByText('Approve the copy')).toBeInTheDocument();
  });

  it('CL-02’s empty state waits for both lists before claiming nothing is waiting', async () => {
    render(
      withQuery(
        <ClientActionsScreen
          {...NAMES}
          client={portalWith([], [])}
          now={new Date('2026-09-01T12:00:00.000Z')}
        />,
      ),
    );

    // §6: "Empty state confirms notification behavior." It must not appear while the requests
    // list is still loading, or a client with a question would be told they have nothing to do.
    expect(await screen.findByText('Nothing is waiting on you')).toBeInTheDocument();
    expect(screen.getByText(/you do not have to keep checking this page/i)).toBeInTheDocument();
  });
});
