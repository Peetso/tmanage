import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ProjectOverviewScreen } from '../src/components/screens/ProjectOverviewScreen';
import { WorkItemDetailScreen } from '../src/components/screens/WorkItemDetailScreen';
import { WorkListScreen } from '../src/components/screens/WorkListScreen';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

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
    version: 3,
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
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

describe('TM-13 the work item detail', () => {
  function renderDetail(handler: (call: Call) => Response) {
    const { client, calls } = clientOver(handler);
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

  it('shows a 409 as somebody else changing it, and does not retry', async () => {
    let posts = 0;
    const calls = renderDetail((call) => {
      if (call.method === 'POST') {
        posts += 1;
        return json({ code: 'conflict', message: 'The item changed since you read it' }, 409);
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

  it('asserts Internal only after the shares endpoint answered empty', async () => {
    renderOverview([]);

    const header = await screen.findByRole('region', { name: 'This project' });
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
