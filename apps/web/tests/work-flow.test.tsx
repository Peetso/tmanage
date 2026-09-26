import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ProjectOverviewScreen } from '../src/components/screens/ProjectOverviewScreen';
import { WorkItemDetailScreen } from '../src/components/screens/WorkItemDetailScreen';
import { WorkListScreen } from '../src/components/screens/WorkListScreen';
import { WorkSavedViewsScreen } from '../src/components/screens/WorkSavedViewsScreen';
import { ApiClient } from '../src/lib/api/client';
import { LOADING_MEMBER_LABEL } from '../src/lib/members-presentation';
import { expectNoAxeViolations } from './axe';
import { expectInertUntilAnswered, heldAnswer } from './hydration-gate';

/**
 * `TM-03`, `TM-10` and `TM-13` against the endpoints WORK-001 delivered.
 *
 * What the API does — the state machine's refusals, the composite keys, the audit rows, the
 * 409 on a stale version — is proved in `apps/api/test/work-001-work-items.db.test.ts` against
 * a real MySQL. Nothing here re-proves any of it.
 *
 * What only this file can prove is what the *screens* do with those answers:
 *
 * - The transition form asks for the facts the machine requires and for nothing else, and it
 *   asks the machine rather than restating §5.
 * - A `409` is shown as "somebody else changed this", and is never retried.
 * - Widening the audience is confirmed before it is sent; narrowing is not.
 * - The work list sends its filters as query parameters rather than filtering in the browser,
 *   which is what keeps a client principal's list from being assembled client-side.
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

const NOW = new Date('2026-09-01T12:00:00.000Z');

function workItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wi-1',
    projectId: 'proj-1',
    type: 'task',
    title: 'Draft the homepage copy',
    state: 'in_progress',
    ownerUserId: 'user-1',
    audience: 'internal',
    startAt: null,
    dueAt: '2026-09-10T17:00:00.000Z',
    completedAt: null,
    version: 3,
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

/** The API's envelope, exactly — `toApiRequestError` reads `body.error`, not `body`. */
function refusal(
  status: number,
  code: string,
  message: string,
  details: readonly { field: string; message: string }[] = [],
): Response {
  return json(
    {
      error: {
        code,
        message,
        correlationId: 'correlation-fixed',
        ...(details.length > 0 ? { details } : {}),
      },
    },
    status,
  );
}

const PROJECTS = {
  projects: [
    {
      id: 'proj-1',
      workspaceId: 'ws-1',
      name: 'Atlas Website Relaunch',
      status: 'active',
      ownerUserId: 'user-1',
      committedAt: null,
      forecastAt: '2026-09-30T00:00:00.000Z',
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:00:00.000Z',
      archivedAt: null,
    },
  ],
};

describe('TM-10 the work list', () => {
  /**
   * The x38 defect (CL-09) on TM-10's filters. The project select and the state checkboxes are
   * controlled inputs in the server-rendered HTML with nothing gating them, so a filter set
   * before React hydrated was held by the DOM alone: hydration re-applied `''` and an empty
   * state list, the table below stayed unfiltered, and nothing said why. They now sit behind
   * `disabled={projects.isPending}` — the projects query rather than `workItems`, which
   * re-pends on every filter change and would lock the filters the moment one was used.
   */
  it('takes no filter until the projects have arrived', async () => {
    const held = heldAnswer();
    const { client } = clientOver((call) =>
      call.url.includes('/work-items')
        ? json({ workItems: [workItem()] })
        : held.after(() => json(PROJECTS)),
    );

    render(
      withQuery(
        <WorkListScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          client={client}
          now={NOW}
        />,
      ),
    );

    const project = screen.getByLabelText('Project');
    const inProgress = screen.getByRole('checkbox', { name: 'In progress' });
    await expectInertUntilAnswered([project, inProgress], held.answer);

    await userEvent.click(inProgress);
    expect(inProgress).toBeChecked();
  });

  it('renders a real table with a row per item', async () => {
    const { client } = clientOver((call) =>
      call.url.includes('/work-items') ? json({ workItems: [workItem()] }) : json(PROJECTS),
    );

    render(
      withQuery(
        <WorkListScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          client={client}
          now={NOW}
        />,
      ),
    );

    const row = await screen.findByRole('row', { name: /Draft the homepage copy/ });
    expect(within(row).getByText('In progress')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'Draft the homepage copy' })).toHaveAttribute(
      'href',
      '/northstar/work/wi-1',
    );
  });

  it('sends the state filter to the API rather than filtering in the browser', async () => {
    const { client, calls } = clientOver((call) =>
      call.url.includes('/work-items') ? json({ workItems: [] }) : json(PROJECTS),
    );

    render(
      withQuery(
        <WorkListScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          client={client}
          now={NOW}
        />,
      ),
    );

    await screen.findByRole('group', { name: 'State' });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Blocked' }));

    await waitFor(() => {
      expect(calls.some((call) => call.url.includes('state=blocked'))).toBe(true);
    });
  });

  it('sends the project filter as a query parameter', async () => {
    const { client, calls } = clientOver((call) =>
      call.url.includes('/work-items') ? json({ workItems: [] }) : json(PROJECTS),
    );

    render(
      withQuery(
        <WorkListScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          client={client}
          now={NOW}
        />,
      ),
    );

    await screen.findByRole('option', { name: 'Atlas Website Relaunch' });
    await userEvent.selectOptions(screen.getByLabelText('Project'), 'proj-1');

    await waitFor(() => {
      expect(calls.some((call) => call.url.includes('projectId=proj-1'))).toBe(true);
    });
  });

  it('marks an item past its due date, and does not mark a finished one', async () => {
    const { client } = clientOver((call) =>
      call.url.includes('/work-items')
        ? json({
            workItems: [
              workItem({ id: 'wi-late', title: 'Late thing', dueAt: '2026-08-01T00:00:00.000Z' }),
              workItem({
                id: 'wi-done',
                title: 'Finished late thing',
                state: 'done',
                dueAt: '2026-08-01T00:00:00.000Z',
              }),
            ],
          })
        : json(PROJECTS),
    );

    render(
      withQuery(
        <WorkListScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          client={client}
          now={NOW}
        />,
      ),
    );

    const late = await screen.findByRole('row', { name: /Late thing/ });
    expect(within(late).getByText('Overdue')).toBeInTheDocument();

    const finished = screen.getByRole('row', { name: /Finished late thing/ });
    expect(within(finished).queryByText('Overdue')).not.toBeInTheDocument();
  });

  it('says a client-facing item is client-facing, in words', async () => {
    const { client } = clientOver((call) =>
      call.url.includes('/work-items')
        ? json({ workItems: [workItem({ audience: 'client_action_required' })] })
        : json(PROJECTS),
    );

    render(
      withQuery(
        <WorkListScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          client={client}
          now={NOW}
        />,
      ),
    );

    expect(await screen.findByText('Client action needed')).toBeInTheDocument();
  });

  it('says nothing is here rather than showing an empty table', async () => {
    const { client } = clientOver((call) =>
      call.url.includes('/work-items') ? json({ workItems: [] }) : json(PROJECTS),
    );

    render(
      withQuery(
        <WorkListScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          client={client}
          now={NOW}
        />,
      ),
    );

    expect(await screen.findByText(/No work items exist in this organization/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('asks for the largest page the API will give', async () => {
    const { client, calls } = clientOver((call) =>
      call.url.includes('/work-items') ? json({ workItems: [] }) : json(PROJECTS),
    );

    render(
      withQuery(
        <WorkListScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          client={client}
          now={NOW}
        />,
      ),
    );

    await waitFor(() => {
      expect(calls.some((call) => call.url.includes('limit=200'))).toBe(true);
    });
  });

  it('says so when the page came back full, rather than implying that is all the work', async () => {
    const full = Array.from({ length: 200 }, (_, index) =>
      workItem({ id: `wi-${index}`, title: `Item ${index}` }),
    );
    const { client } = clientOver((call) =>
      call.url.includes('/work-items') ? json({ workItems: full }) : json(PROJECTS),
    );

    render(
      withQuery(
        <WorkListScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          client={client}
          now={NOW}
        />,
      ),
    );

    expect(await screen.findByText(/This is not all of it/)).toBeInTheDocument();
  });

  it('says nothing about paging when the page was not full', async () => {
    const { client } = clientOver((call) =>
      call.url.includes('/work-items') ? json({ workItems: [workItem()] }) : json(PROJECTS),
    );

    render(
      withQuery(
        <WorkListScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          client={client}
          now={NOW}
        />,
      ),
    );

    await screen.findByRole('table');
    expect(screen.queryByText(/This is not all of it/)).not.toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { client } = clientOver((call) =>
      call.url.includes('/work-items') ? json({ workItems: [workItem()] }) : json(PROJECTS),
    );

    const { container } = render(
      withQuery(
        <WorkListScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          client={client}
          now={NOW}
        />,
      ),
    );

    await screen.findByRole('table');
    await expectNoAxeViolations(container);
  });
});

describe('TM-10 second half — paging, sorting, selection, bulk audience', () => {
  function renderList(handler: (call: Call) => Response) {
    const { client, calls } = clientOver(handler);
    render(
      withQuery(
        <WorkListScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          client={client}
          now={NOW}
        />,
      ),
    );
    return calls;
  }

  it('loads the next page with the last row as the cursor, and stops warning when done', async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) =>
      workItem({ id: `wi-${String(index).padStart(3, '0')}`, title: `Item ${index}` }),
    );
    const calls = renderList((call) => {
      if (!call.url.includes('/work-items')) return json(PROJECTS);
      if (call.url.includes('after=')) {
        return json({ workItems: [workItem({ id: 'wi-final', title: 'The 201st item' })] });
      }
      return json({ workItems: firstPage });
    });

    expect(await screen.findByText(/This is not all of it/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('The 201st item')).toBeInTheDocument();
    expect(calls.some((call) => call.url.includes('after=wi-199'))).toBe(true);
    // The second page was short, so there is no more to load and no more to warn about.
    expect(screen.queryByText(/This is not all of it/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('sorts the loaded rows from a header, announces the direction, and can return to loaded order', async () => {
    renderList((call) =>
      call.url.includes('/work-items')
        ? json({
            workItems: [
              workItem({ id: 'b', title: 'Beta task' }),
              workItem({ id: 'a', title: 'Alpha task' }),
            ],
          })
        : json(PROJECTS),
    );

    await screen.findByRole('table');
    const titles = () =>
      screen.getAllByRole('rowheader').map((cell) => cell.textContent?.trim() ?? '');

    expect(titles()).toEqual(['Beta task', 'Alpha task']);

    const header = screen.getByRole('button', { name: /^Title/ });
    await userEvent.click(header);
    expect(titles()).toEqual(['Alpha task', 'Beta task']);
    expect(header.closest('th')).toHaveAttribute('aria-sort', 'ascending');

    await userEvent.click(header);
    expect(titles()).toEqual(['Beta task', 'Alpha task']);
    expect(header.closest('th')).toHaveAttribute('aria-sort', 'descending');

    // A third click returns to loaded order rather than cycling forever.
    await userEvent.click(header);
    expect(header.closest('th')).not.toHaveAttribute('aria-sort');
  });

  it('previews a bulk widening by title, applies it with each row own version, and reports a 409 without retrying', async () => {
    const patched: Call[] = [];
    const calls = renderList((call) => {
      if (call.method === 'PATCH') {
        patched.push(call);
        if (call.url.endsWith('/wi-2')) {
          return json(
            {
              error: {
                code: 'conflict',
                message: 'Someone changed this while you were working. Reload and try again.',
                correlationId: 'corr',
              },
            },
            409,
          );
        }
        return json(workItem({ id: 'wi-1', audience: 'client_visible', version: 4 }));
      }
      return call.url.includes('/work-items')
        ? json({
            workItems: [
              workItem({ id: 'wi-1', title: 'First thing', version: 3 }),
              workItem({ id: 'wi-2', title: 'Second thing', version: 7 }),
            ],
          })
        : json(PROJECTS);
    });

    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select First thing' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Second thing' }));

    // The bulk bar appears with the selection, and widening opens the preview.
    await userEvent.click(screen.getByRole('button', { name: 'Client can see' }));
    const preview = await screen.findByText('This will show items to the client');
    expect(preview).toBeInTheDocument();
    expect(screen.getByText('“First thing”')).toBeInTheDocument();
    expect(screen.getByText('“Second thing”')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Show them to the client' }));

    await screen.findByText('Audience changed on 1 item');
    expect(screen.getByText(/“Second thing” — Someone changed this/)).toBeInTheDocument();

    // Each PATCH carried the version its row was read with, and the refusal was not retried.
    expect(patched).toHaveLength(2);
    expect(patched[0]?.body).toEqual({ version: 3, audience: 'client_visible' });
    expect(patched[1]?.body).toEqual({ version: 7, audience: 'client_visible' });
    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(2);
  });

  it('narrows without ceremony — internal is applied with no preview', async () => {
    const patched: Call[] = [];
    renderList((call) => {
      if (call.method === 'PATCH') {
        patched.push(call);
        return json(workItem({ id: 'wi-1', audience: 'internal', version: 4 }));
      }
      return call.url.includes('/work-items')
        ? json({
            workItems: [
              workItem({ id: 'wi-1', title: 'Shared thing', audience: 'client_visible' }),
            ],
          })
        : json(PROJECTS);
    });

    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Shared thing' }));
    await userEvent.click(screen.getByRole('button', { name: 'Internal' }));

    await screen.findByText('Audience changed on 1 item');
    expect(screen.queryByText('This will show items to the client')).not.toBeInTheDocument();
    expect(patched).toHaveLength(1);
  });
});

/**
 * The organization's members, as `GET /v1/organizations/:orgSlug/members` answers — D16.
 *
 * The detail screen now reads this list to show who an owner *is* and to offer the people a
 * transition can name. Every test in the block below gets it, because a screen that renders
 * without it is not the screen a person uses.
 */
const MEMBERS = {
  members: [
    { userId: 'user-1', displayName: 'Ada Okonkwo', role: 'member', status: 'active' },
    { userId: 'user-omar', displayName: 'Omar Haddad', role: 'manager', status: 'active' },
  ],
  nextAfter: null,
};

describe('TM-13 the work item detail', () => {
  function renderDetail(handler: (call: Call) => Response) {
    const { client, calls } = clientOver((call) =>
      call.url.includes('/members') ? json(MEMBERS) : handler(call),
    );
    render(
      withQuery(
        <WorkItemDetailScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          workItemId="wi-1"
          client={client}
        />,
      ),
    );
    return calls;
  }

  it('offers only the states the machine can reach from this one', async () => {
    renderDetail(() => json(workItem({ state: 'in_progress' })));

    await screen.findByLabelText('Move to');
    // §5 from in_progress: ready, blocked, internal_review. Nothing else.
    expect(screen.getByRole('option', { name: 'Ready' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Blocked' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Internal review' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Done' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Archived' })).not.toBeInTheDocument();
  });

  it('asks for exactly the facts the chosen move requires', async () => {
    renderDetail(() => json(workItem({ state: 'in_progress' })));

    await screen.findByLabelText('Move to');
    await userEvent.selectOptions(screen.getByLabelText('Move to'), 'blocked');

    expect(screen.getByLabelText(/What is blocking this/)).toBeInTheDocument();
    expect(screen.getByLabelText(/What you need, and from whom/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/How it was resolved/)).not.toBeInTheDocument();
  });

  it('asks for nothing when the move requires nothing', async () => {
    renderDetail(() => json(workItem({ state: 'in_progress' })));

    await screen.findByLabelText('Move to');
    await userEvent.selectOptions(screen.getByLabelText('Move to'), 'internal_review');

    expect(screen.getByText('This move needs nothing else from you.')).toBeInTheDocument();
  });

  it('sends the facts and the version it read', async () => {
    const calls = renderDetail((call) =>
      call.method === 'POST' ? json(workItem({ state: 'blocked', version: 4 })) : json(workItem()),
    );

    await screen.findByLabelText('Move to');
    await userEvent.selectOptions(screen.getByLabelText('Move to'), 'blocked');
    await userEvent.type(screen.getByLabelText(/What is blocking this/), 'Waiting on brand assets');
    await userEvent.type(screen.getByLabelText(/What you need, and from whom/), 'Logos from Priya');
    await userEvent.click(screen.getByRole('button', { name: /Move to Blocked/ }));

    await waitFor(() => {
      const posted = calls.find((call) => call.method === 'POST');
      expect(posted?.url).toContain('/work-items/wi-1/transitions');
      expect(posted?.body).toEqual({
        version: 3,
        to: 'blocked',
        facts: {
          blockerReason: 'Waiting on brand assets',
          blockerAsk: 'Logos from Priya',
        },
      });
    });
  });

  it('shows a version 409 as somebody else changing it, and does not retry', async () => {
    let posts = 0;
    const calls = renderDetail((call) => {
      if (call.method === 'POST') {
        posts += 1;
        // The envelope `WorkItemsService.writing` actually sends: `conflict`, and the field
        // that was wrong is the version token.
        return refusal(
          409,
          'conflict',
          'The resource was modified concurrently. Reload and try again',
          [{ field: 'version', message: 'the item changed since you read it' }],
        );
      }
      return json(workItem());
    });

    await screen.findByLabelText('Move to');
    await userEvent.selectOptions(screen.getByLabelText('Move to'), 'internal_review');
    await userEvent.click(screen.getByRole('button', { name: /Move to Internal review/ }));

    expect(await screen.findByText(/Somebody else changed this first/)).toBeInTheDocument();
    expect(posts).toBe(1);
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('shows the other 409 — an active blocker already exists — in the API words, not as a reload', async () => {
    // Recorded 2026-08-31 as "two different 409s render as one". The already-blocked refusal
    // names no field, because no field of the request was wrong; "reload and try again"
    // cannot help it, and the screen must not say it.
    renderDetail((call) =>
      call.method === 'POST'
        ? refusal(409, 'conflict', 'This work item already has an active blocker')
        : json(workItem()),
    );

    await screen.findByLabelText('Move to');
    await userEvent.selectOptions(screen.getByLabelText('Move to'), 'blocked');
    await userEvent.type(screen.getByLabelText(/What is blocking this/), 'Waiting on brand assets');
    await userEvent.type(screen.getByLabelText(/What you need, and from whom/), 'Logos from Priya');
    await userEvent.click(screen.getByRole('button', { name: /Move to Blocked/ }));

    expect(
      await screen.findByText('This work item already has an active blocker'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Somebody else changed this first/)).not.toBeInTheDocument();
  });

  it('offers the blocker owner as optional, and leaves it out of the request when blank', async () => {
    const calls = renderDetail((call) =>
      call.method === 'POST' ? json(workItem({ state: 'blocked', version: 4 })) : json(workItem()),
    );

    await screen.findByLabelText('Move to');
    await userEvent.selectOptions(screen.getByLabelText('Move to'), 'blocked');

    // Offered, and not marked required — the asterisk is the machine's word, not the form's.
    // Role-based: the picker's popup carries the same accessible name as its input, so a
    // label query alone is ambiguous.
    const owner = screen.getByRole('combobox', { name: /Who the ask is on/ });
    expect(owner).toBeInTheDocument();
    expect(owner).not.toBeRequired();
    expect(screen.getByLabelText(/What is blocking this/)).toBeRequired();

    await userEvent.type(screen.getByLabelText(/What is blocking this/), 'No sandbox key');
    await userEvent.type(
      screen.getByLabelText(/What you need, and from whom/),
      'The key, from Atlas',
    );
    await userEvent.click(screen.getByRole('button', { name: /Move to Blocked/ }));

    await waitFor(() => {
      const posted = calls.find((call) => call.method === 'POST');
      expect(posted?.body).toEqual({
        version: 3,
        to: 'blocked',
        facts: { blockerReason: 'No sandbox key', blockerAsk: 'The key, from Atlas' },
      });
    });
  });

  it('sends the blocker owner when one is named', async () => {
    const calls = renderDetail((call) =>
      call.method === 'POST' ? json(workItem({ state: 'blocked', version: 4 })) : json(workItem()),
    );

    await screen.findByLabelText('Move to');
    await userEvent.selectOptions(screen.getByLabelText('Move to'), 'blocked');
    await userEvent.type(screen.getByLabelText(/What is blocking this/), 'No sandbox key');
    await userEvent.type(
      screen.getByLabelText(/What you need, and from whom/),
      'The key, from Atlas',
    );
    // D16. The person is chosen by name — nobody types or pastes `user-omar` — and the id is
    // still what travels. This is the whole finding in one assertion: "Preserve IDs in the
    // API, not as required human input."
    await userEvent.type(screen.getByRole('combobox', { name: /Who the ask is on/ }), 'Omar');
    await userEvent.click(await screen.findByRole('option', { name: /Omar Haddad/ }));
    await userEvent.click(screen.getByRole('button', { name: /Move to Blocked/ }));

    await waitFor(() => {
      const posted = calls.find((call) => call.method === 'POST');
      expect((posted?.body as { facts: Record<string, string> }).facts).toEqual({
        blockerReason: 'No sandbox key',
        blockerAsk: 'The key, from Atlas',
        blockerOwnerUserId: 'user-omar',
      });
    });
  });

  it('opens the done move with the current owner and now filled in, and sends an instant', async () => {
    const calls = renderDetail((call) =>
      call.method === 'POST'
        ? json(
            workItem({
              state: 'done',
              version: 4,
              completedAt: '2026-09-01T11:30:00.000Z',
            }),
          )
        : json(workItem({ state: 'internal_review' })),
    );

    await screen.findByLabelText('Move to');
    await userEvent.selectOptions(screen.getByLabelText('Move to'), 'done');

    // Seeded with the item's current owner, and shown as the name that owner has rather than
    // as the id the row stores.
    const owner = await screen.findByRole('combobox', { name: /Who owned this to completion/ });
    await waitFor(() => expect(owner).toHaveValue('Ada Okonkwo · Team member'));
    const completed = screen.getByLabelText(/When it was completed/);
    expect(completed).toHaveAttribute('type', 'datetime-local');
    expect((completed as HTMLInputElement).value).not.toBe('');

    // A person corrects the time to when the work was actually finished.
    await userEvent.clear(completed);
    await userEvent.type(completed, '2026-09-01T11:30');
    await userEvent.click(screen.getByRole('button', { name: /Move to Done/ }));

    await waitFor(() => {
      const posted = calls.find((call) => call.method === 'POST');
      const body = posted?.body as { to: string; facts: Record<string, string> };
      expect(body.to).toBe('done');
      expect(body.facts['ownerId']).toBe('user-1');
      // What was typed is local time; what travels is the UTC instant it names.
      expect(body.facts['completedAt']).toBe(new Date('2026-09-01T11:30').toISOString());
    });

    // And the answer's completion time is shown as a fact of the item.
    expect(await screen.findByText('Completed')).toBeInTheDocument();
  });

  it('shows no Completed row for an item that has not been completed', async () => {
    renderDetail(() => json(workItem()));
    await screen.findByLabelText('Move to');
    expect(screen.queryByText('Completed')).not.toBeInTheDocument();
  });

  it('confirms before widening the audience to the client', async () => {
    const calls = renderDetail((call) =>
      call.method === 'PATCH'
        ? json(workItem({ audience: 'client_visible', version: 4 }))
        : json(workItem()),
    );

    await screen.findByRole('button', { name: 'Client can see' });
    await userEvent.click(screen.getByRole('button', { name: 'Client can see' }));

    // Nothing has been sent yet — the confirmation is the point.
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);
    expect(screen.getByText(/This will show the item to the client/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Show it to the client' }));

    await waitFor(() => {
      const patched = calls.find((call) => call.method === 'PATCH');
      expect(patched?.body).toEqual({ version: 3, audience: 'client_visible' });
    });
  });

  it('does not confirm when narrowing back to internal', async () => {
    const calls = renderDetail((call) =>
      call.method === 'PATCH'
        ? json(workItem({ audience: 'internal', version: 4 }))
        : json(workItem({ audience: 'client_visible' })),
    );

    await screen.findByRole('button', { name: 'Internal' });
    await userEvent.click(screen.getByRole('button', { name: 'Internal' }));

    await waitFor(() => {
      const patched = calls.find((call) => call.method === 'PATCH');
      expect(patched?.body).toEqual({ version: 3, audience: 'internal' });
    });
  });

  it('says there is nowhere to go from a terminal state', async () => {
    renderDetail(() => json(workItem({ state: 'archived' })));

    expect(await screen.findByText(/is the end of the lifecycle/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Move to')).not.toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { client } = clientOver(() => json(workItem()));
    const { container } = render(
      withQuery(
        <WorkItemDetailScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          workItemId="wi-1"
          client={client}
        />,
      ),
    );

    await screen.findByLabelText('Move to');
    await expectNoAxeViolations(container);
  });
});

describe('TM-03 the project overview', () => {
  function renderOverview(items: readonly unknown[], shares: readonly unknown[] = []) {
    const { client } = clientOver((call) =>
      call.url.includes('/work-items')
        ? json({ workItems: items })
        : call.url.includes('/clients')
          ? json({ clients: shares })
          : json(PROJECTS.projects[0] as unknown),
    );
    render(
      withQuery(
        <ProjectOverviewScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          projectId="proj-1"
          client={client}
          now={NOW}
        />,
      ),
    );
  }

  it('keeps committed and forecast as two different things', async () => {
    renderOverview([]);

    expect(await screen.findByText('Nothing committed yet')).toBeInTheDocument();
    expect(screen.getByText(/30 Sep 2026|Sep 30, 2026|September 30, 2026/)).toBeInTheDocument();
  });

  it('explains how it is going with counts, and no score', async () => {
    renderOverview([
      workItem({ id: 'a', state: 'blocked', title: 'Blocked thing' }),
      workItem({
        id: 'b',
        state: 'in_progress',
        dueAt: '2026-08-01T00:00:00.000Z',
        title: 'Late thing',
      }),
      workItem({ id: 'c', state: 'done', title: 'Done thing' }),
    ]);

    expect(
      await screen.findByText('One item is blocked, and one item is past its due date.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/These are counts, not a score/)).toBeInTheDocument();
  });

  it('says its counts are a page rather than a total when the page came back full', async () => {
    renderOverview(
      Array.from({ length: 200 }, (_, index) =>
        workItem({ id: `wi-${index}`, title: `Item ${index}` }),
      ),
    );

    expect(await screen.findByText(/These counts are a page, not a total/)).toBeInTheDocument();
  });

  it('lists blockers separately from next actions', async () => {
    renderOverview([
      workItem({ id: 'a', state: 'blocked', title: 'Blocked thing' }),
      workItem({ id: 'b', state: 'ready', title: 'Ready thing' }),
    ]);

    // Wait for the item, not for the section. Both sections render immediately with their
    // empty copy while the query is in flight, so awaiting the region would resolve against
    // the empty one and then assert on it.
    await screen.findByText('Blocked thing');

    const blockers = screen.getByRole('region', { name: 'Blockers' });
    expect(within(blockers).getByText('Blocked thing')).toBeInTheDocument();
    expect(within(blockers).queryByText('Ready thing')).not.toBeInTheDocument();

    const next = screen.getByRole('region', { name: 'Next actions' });
    expect(within(next).getByText('Ready thing')).toBeInTheDocument();
  });

  it('names every item a client would be able to see', async () => {
    renderOverview([
      workItem({ id: 'a', audience: 'client_visible', title: 'Shared thing' }),
      workItem({ id: 'b', audience: 'internal', title: 'Private thing' }),
    ]);

    // `findAllBy`, because the same item legitimately appears twice: it is in progress, so it
    // is a next action, and it is client-visible, so it is also in the list below. Sections on
    // this screen are views of the same work, not a partition of it.
    await screen.findAllByText('Shared thing');

    const shared = screen.getByRole('region', { name: 'What the client can see' });
    expect(within(shared).getByText('Shared thing')).toBeInTheDocument();
    expect(within(shared).queryByText('Private thing')).not.toBeInTheDocument();
  });

  it('shows no badge until the shares endpoint answers, then Internal once it answered empty', async () => {
    // The shares endpoint is held open, so the header renders (the project resolved) while the
    // shares query is still in flight. This is the "only after" the title claims: the badge must
    // be *absent* here, not defaulted to "Internal" the way the pre-CLIENT-001 screen was.
    let answerShares!: (response: Response) => void;
    const shares = new Promise<Response>((resolve) => {
      answerShares = resolve;
    });
    const { client } = clientOver((call) =>
      call.url.includes('/work-items')
        ? json({ workItems: [] })
        : call.url.includes('/clients')
          ? shares
          : json(PROJECTS.projects[0] as unknown),
    );
    render(
      withQuery(
        <ProjectOverviewScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          projectId="proj-1"
          client={client}
          now={NOW}
        />,
      ),
    );

    const header = await screen.findByRole('region', { name: 'This project' });
    expect(within(header).queryByText('Internal')).not.toBeInTheDocument();

    answerShares(json({ clients: [] }));
    await within(header).findByText('Internal');
  });

  it('says a shared project is shared, instead of the old unconditional Internal', async () => {
    renderOverview(
      [],
      [
        {
          id: 'share-1',
          projectId: 'proj-1',
          clientOrganizationId: 'client-1',
          createdAt: '2026-08-01T00:00:00.000Z',
        },
      ],
    );

    const header = await screen.findByRole('region', { name: 'This project' });
    await within(header).findByText('Shared with a client');
    expect(within(header).queryByText('Internal')).not.toBeInTheDocument();
  });

  it('draws no badge at all when it cannot know — the shares endpoint refused', async () => {
    const { client } = clientOver((call) =>
      call.url.includes('/work-items')
        ? json({ workItems: [] })
        : call.url.includes('/clients')
          ? json(
              {
                error: {
                  code: 'forbidden',
                  message: 'You do not have access to this.',
                  correlationId: 'corr',
                },
              },
              403,
            )
          : json(PROJECTS.projects[0] as unknown),
    );
    render(
      withQuery(
        <ProjectOverviewScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          projectId="proj-1"
          client={client}
          now={NOW}
        />,
      ),
    );

    const header = await screen.findByRole('region', { name: 'This project' });
    // A badge the screen cannot verify is a guess; the old screen guessed "Internal".
    expect(within(header).queryByText('Internal')).not.toBeInTheDocument();
    expect(within(header).queryByText('Shared with a client')).not.toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { client } = clientOver((call) =>
      call.url.includes('/work-items')
        ? json({ workItems: [workItem()] })
        : call.url.includes('/clients')
          ? json({ clients: [] })
          : json(PROJECTS.projects[0] as unknown),
    );

    const { container } = render(
      withQuery(
        <ProjectOverviewScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          projectId="proj-1"
          client={client}
          now={NOW}
        />,
      ),
    );

    await screen.findByRole('region', { name: 'Blockers' });
    await expectNoAxeViolations(container);
  });
});

/**
 * The two screens share one `QueryClient` and are one click apart.
 *
 * `ProjectOverviewScreen`'s "Update work" action links to `/{slug}/work?project={id}`, which
 * is a client-side navigation: the provider does not remount, so whatever the first screen
 * cached is still there when the second one asks. They cache *different shapes* — the list
 * pages through `useInfiniteQuery` and holds `{ pages, pageParams }`, the overview holds a
 * plain array — and they used to name the same key, because the overview's fourth segment was
 * `''` and the list's was `[].sort().join(',')`, which is also `''`. Whichever arrived second
 * read the other's entry as fresh, called `.pages.flat()` on an array or `.filter` on an
 * object, and threw: a blank crash rather than an error anyone could act on.
 *
 * `workItemKeys` puts the shape word in the key, so the collision cannot be reconstructed by
 * argument. These two tests walk it in both directions with one client, and `staleTime` is set
 * to the value `QueryProvider` actually uses, because a zero stale time would refetch and hide
 * the bug rather than reproduce it.
 */
describe('the work surfaces share a cache, and must not share a cache entry', () => {
  function sharedQueryClient(): QueryClient {
    return new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: 30_000 },
        mutations: { retry: false },
      },
    });
  }

  function workAndProjectRoutes(call: Call): Response {
    if (call.url.includes('/work-items')) return json({ workItems: [workItem()] });
    if (call.url.includes('/clients')) return json({ clients: [] });
    if (call.url.includes('/projects/proj-1')) return json(PROJECTS.projects[0] as unknown);
    return json(PROJECTS);
  }

  it('the work list still renders when the project overview filled the cache first', async () => {
    const { client } = clientOver(workAndProjectRoutes);
    const queries = sharedQueryClient();

    const overview = render(
      <QueryClientProvider client={queries}>
        <ProjectOverviewScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          projectId="proj-1"
          client={client}
          now={NOW}
        />
      </QueryClientProvider>,
    );
    await screen.findByRole('region', { name: 'Blockers' });
    overview.unmount();

    render(
      <QueryClientProvider client={queries}>
        <WorkListScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          initialProjectId="proj-1"
          client={client}
          now={NOW}
        />
      </QueryClientProvider>,
    );

    expect(await screen.findByRole('row', { name: /Draft the homepage copy/ })).toBeInTheDocument();
  });

  it('the project overview still renders when the work list filled the cache first', async () => {
    const { client } = clientOver(workAndProjectRoutes);
    const queries = sharedQueryClient();

    const list = render(
      <QueryClientProvider client={queries}>
        <WorkListScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          initialProjectId="proj-1"
          client={client}
          now={NOW}
        />
      </QueryClientProvider>,
    );
    await screen.findByRole('row', { name: /Draft the homepage copy/ });
    list.unmount();

    render(
      <QueryClientProvider client={queries}>
        <ProjectOverviewScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          projectId="proj-1"
          client={client}
          now={NOW}
        />
      </QueryClientProvider>,
    );

    const health = await screen.findByRole('region', { name: 'How it is going' });
    expect(
      await within(health).findByText('Nothing is blocked and nothing is past its due date.'),
    ).toBeInTheDocument();
  });
});

/**
 * D16 follow-up (x42): the owner reads as a name, not an id, on the three surfaces the x36
 * reviewer left open. Each surface resolves its stored `ownerUserId` through the one members
 * directory `useMembers` loads — the same list the picker offers — so an owner and the people
 * a transition can name can never come from two different answers. `user-1` is Ada Okonkwo.
 */
describe('D16 follow-up — the owner reads as a name on all three surfaces (x42)', () => {
  it('names the project owner rather than saying only "Assigned"', async () => {
    const { client } = clientOver((call) =>
      call.url.includes('/members')
        ? json(MEMBERS)
        : call.url.includes('/work-items')
          ? json({ workItems: [] })
          : call.url.includes('/clients')
            ? json({ clients: [] })
            : json(PROJECTS.projects[0] as unknown),
    );
    render(
      withQuery(
        <ProjectOverviewScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          projectId="proj-1"
          client={client}
          now={NOW}
        />,
      ),
    );

    expect(await screen.findByText('Ada Okonkwo')).toBeInTheDocument();
    expect(screen.queryByText(/user-1/)).not.toBeInTheDocument();
  });

  it('names each work-list row owner rather than saying only "Assigned"', async () => {
    const { client } = clientOver((call) =>
      call.url.includes('/members')
        ? json(MEMBERS)
        : call.url.includes('/work-items')
          ? json({ workItems: [workItem()] })
          : json(PROJECTS),
    );
    render(
      withQuery(
        <WorkListScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          client={client}
          now={NOW}
        />,
      ),
    );

    expect(await screen.findByText('Ada Okonkwo')).toBeInTheDocument();
    expect(screen.queryByText(/user-1/)).not.toBeInTheDocument();
  });

  it('resolves the detail owner line from loading to a name, never a former-member label', async () => {
    let release: (value: Response) => void = () => {};
    const membersPending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { client } = clientOver((call) =>
      call.url.includes('/members') ? membersPending : json(workItem({ state: 'in_progress' })),
    );
    render(
      withQuery(
        <WorkItemDetailScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          workItemId="wi-1"
          client={client}
        />,
      ),
    );

    // While the directory is in flight the owner line says it is loading — not that a present
    // colleague is a former member, which is what the two-argument call rendered.
    expect(await screen.findByText(LOADING_MEMBER_LABEL)).toBeInTheDocument();
    expect(screen.queryByText(/Former or hidden member/)).not.toBeInTheDocument();

    // It resolves to the name once the directory answers.
    release(json(MEMBERS));
    expect(await screen.findByText('Ada Okonkwo')).toBeInTheDocument();
  });
});

/**
 * WK-08 the saved view editor (x107).
 *
 * What the API proves elsewhere — the tenant- and owner-scoped table, the 404 on an unknown or
 * cross-tenant project, the off-owner refusal — is proved in `work-008-saved-views.db.test.ts`
 * and `work-views.service.test.ts`. This block proves only what the *screen* does: it reads the
 * caller's own plus the studio's shared views, composes the config the person typed into the
 * request the API expects, and loads a saved view back into the form so it can be re-applied.
 */
const SAVED_PROJECTS = {
  projects: [{ id: 'proj-1', name: 'Atlas Website Relaunch' }],
};

function savedView(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sv-1',
    ownerUserId: 'user-1',
    projectId: 'proj-1',
    name: 'My board',
    config: { filters: [], grouping: 'state', columns: ['title', 'state'] },
    shared: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('WK-08 the saved view editor', () => {
  function renderScreen(handler: (call: Call) => Response | Promise<Response>) {
    const { client, calls } = clientOver(handler);
    render(
      withQuery(
        <WorkSavedViewsScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          client={client}
        />,
      ),
    );
    return calls;
  }

  it('lists the views the caller may see, and offers a form to name a new one', async () => {
    renderScreen((call) =>
      call.url.includes('/work-views/saved')
        ? json({
            savedViews: [
              savedView({ id: 'sv-mine', name: 'Mine' }),
              savedView({
                id: 'sv-shared',
                name: 'Team board',
                ownerUserId: 'user-2',
                shared: true,
              }),
            ],
          })
        : json(SAVED_PROJECTS),
    );

    expect(await screen.findByText('Mine')).toBeInTheDocument();
    expect(screen.getByText('Team board')).toBeInTheDocument();
    // The shared view names its audience in words, not as a flag.
    expect(screen.getByText(/Shared/)).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
  });

  it('sends the config the form composed rather than filtering in the browser', async () => {
    const calls = renderScreen((call) => {
      if (call.method === 'POST') return json(savedView({ id: 'sv-new', name: 'Blocked work' }));
      return call.url.includes('/work-views/saved')
        ? json({ savedViews: [] })
        : json(SAVED_PROJECTS);
    });

    await screen.findByLabelText('Name');
    await userEvent.type(screen.getByLabelText('Name'), 'Blocked work');
    await userEvent.type(screen.getByLabelText('Columns'), 'title, state');
    await userEvent.type(screen.getByLabelText('Group by'), 'state');
    await userEvent.click(screen.getByRole('button', { name: 'Save view' }));

    await waitFor(() => {
      const posted = calls.find((call) => call.method === 'POST');
      expect(posted?.url).toContain('/work-views/saved');
      expect(posted?.body).toEqual({
        projectId: null,
        name: 'Blocked work',
        shared: false,
        config: { filters: [], grouping: 'state', columns: ['title', 'state'] },
      });
    });
  });

  it('loads a saved view back into the form so it can be re-applied or copied', async () => {
    renderScreen((call) =>
      call.url.includes('/work-views/saved')
        ? json({ savedViews: [savedView({ id: 'sv-1', name: 'My board' })] })
        : json(SAVED_PROJECTS),
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Load' }));

    expect(screen.getByLabelText('Name')).toHaveValue('My board');
    expect(screen.getByLabelText('Columns')).toHaveValue('title, state');
    expect(screen.getByLabelText('Group by')).toHaveValue('state');
  });

  it('has no axe violations', async () => {
    const { container } = (() => {
      const { client } = clientOver((call) =>
        call.url.includes('/work-views/saved')
          ? json({ savedViews: [savedView()] })
          : json(SAVED_PROJECTS),
      );
      return render(
        withQuery(
          <WorkSavedViewsScreen
            organizationSlug="northstar"
            organizationName="Northstar Studio"
            client={client}
          />,
        ),
      );
    })();

    await screen.findByText('My board');
    await expectNoAxeViolations(container);
  });
});
