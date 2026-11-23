import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { MemberSelect } from '../src/components/MemberSelect';
import { WorkItemDetailScreen } from '../src/components/screens/WorkItemDetailScreen';
import { ApiClient } from '../src/lib/api/client';
import { useMembers } from '../src/lib/use-members';
import type { MemberSummary } from '../src/lib/api/members';

/**
 * `D16` — the member picker, and what the work item detail does with it.
 *
 * The finding was that "core work actions require internal user IDs": the only way to assign
 * an item was to find a UUID and paste it, and the owner then rendered as the word
 * "Assigned". Its acceptance sentence is the shape of this file — "an ordinary project member
 * can assign responsibility ... without finding or pasting a UUID, and can see who is
 * accountable."
 *
 * The API half is proved in `apps/api/src/modules/tenancy/members-directory.test.ts`: the
 * listing is tenant-scoped and no client role can reach it. Nothing here re-proves either.
 * What only this file can prove is that the browser reads names and sends ids.
 *
 * `Combobox`'s own behaviour — arrow keys, virtual focus, Escape, the text and value never
 * disagreeing — belongs to `packages/ui/tests/pickers.test.tsx` and is not repeated.
 */

const MEMBERS: readonly MemberSummary[] = [
  { userId: 'u-ada', displayName: 'Ada Okonkwo', role: 'member', status: 'active' },
  { userId: 'u-omar', displayName: 'Omar Haddad', role: 'manager', status: 'active' },
  { userId: 'u-priya', displayName: 'Priya Raman', role: 'workspace_admin', status: 'active' },
];

function Harness({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <MemberSelect label="Who owns this" members={MEMBERS} value={value} onChange={setValue} />
      {/* What the form actually holds, so an assertion can read it without a submit. */}
      <output data-testid="held">{value}</output>
    </>
  );
}

describe('MemberSelect', () => {
  it('offers people by name and role, and narrows to what was typed', async () => {
    render(<Harness />);

    const field = screen.getByRole('combobox', { name: 'Who owns this' });
    await userEvent.type(field, 'Om');

    // The role is there because two colleagues share a first name often enough that a bare
    // name is not an identity — D16 asks for "clear identity disambiguation".
    expect(
      await screen.findByRole('option', { name: 'Omar Haddad · Manager' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Ada Okonkwo/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Priya Raman/ })).not.toBeInTheDocument();
  });

  it('hands the form a user id although the person only ever read a name', async () => {
    render(<Harness />);

    await userEvent.type(screen.getByRole('combobox', { name: 'Who owns this' }), 'Priya');
    await userEvent.click(await screen.findByRole('option', { name: /Priya Raman/ }));

    expect(screen.getByTestId('held')).toHaveTextContent('u-priya');
    expect(screen.getByRole('combobox', { name: 'Who owns this' })).toHaveValue(
      'Priya Raman · Workspace admin',
    );
  });

  it('shows a stored id the directory does not contain, rather than an empty box', () => {
    // Offboarded, or in a project this reader cannot see. The review asked for "a stable
    // display for removed/inaccessible members"; an empty control would read as "unassigned",
    // which is a different and false fact.
    render(<Harness initial="u-departed" />);

    expect(screen.getByRole('combobox', { name: 'Who owns this' })).toHaveValue(
      'Former or hidden member (u-depart)',
    );
  });

  it('does not call a present colleague a former member while the directory loads', () => {
    // Every id is absent from a list that has not arrived, so the unknown-id label would fire
    // on a perfectly ordinary owner for as long as the fetch takes. "Nobody by that id" and
    // "the names are not here yet" are different facts and only one of them is about a person.
    render(
      <MemberSelect
        label="Who owns this"
        members={[]}
        value="u-ada"
        onChange={() => undefined}
        loading
      />,
    );

    const field = screen.getByRole('combobox', { name: 'Who owns this' });
    expect(field).not.toHaveValue('Former or hidden member (u-ada)');
    expect(field).toHaveValue('Loading this member’s name…');
  });
});

describe('searching the directory', () => {
  function searchClient(calls: string[]): ApiClient {
    return new ApiClient({
      baseUrl: 'https://api.example.test',
      csrfCookieName: 'tm_session_csrf',
      fetch: ((input: RequestInfo | URL) => {
        calls.push(String(input));
        return Promise.resolve(
          new Response(JSON.stringify({ members: MEMBERS, nextAfter: null }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }) as typeof globalThis.fetch,
      readCsrfToken: () => 'csrf-token',
      newCorrelationId: () => 'correlation-fixed',
    });
  }

  function SearchHarness({ client }: { client: ApiClient }) {
    const [search, setSearch] = useState('');
    const directory = useMembers(client, 'northstar', search);
    return (
      <MemberSelect
        label="Who owns this"
        members={directory.members}
        value=""
        onChange={() => undefined}
        onSearchChange={setSearch}
      />
    );
  }

  it('asks the server for what was typed, so somebody past the first page can be found', async () => {
    // The hole this closes: one request is one page of 50, so before this the fifty-first
    // member of an organization was somebody the browser had never been sent and therefore
    // somebody no field here could assign work to. Filtering what had already arrived could
    // never reach them; asking the server can.
    const calls: string[] = [];
    const queries = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    render(
      <QueryClientProvider client={queries}>
        <SearchHarness client={searchClient(calls)} />
      </QueryClientProvider>,
    );

    await userEvent.type(screen.getByRole('combobox', { name: 'Who owns this' }), 'Oma');

    await waitFor(() => {
      expect(calls.some((url) => url.includes('/members?q=Oma'))).toBe(true);
    });
    // Debounced, not per keystroke: three characters are not three round trips.
    expect(calls.filter((url) => url.includes('q=')).length).toBeLessThan(3);
  });
});

describe('TM-13 owner identity', () => {
  /** Only the item, its people and the directory: the page's other reads are not this test's. */
  const OURS = /\/(?:members|people|work-items\/wi-1)(?:\?|$)/u;

  function renderDetail(ownerUserId: string | null) {
    const client = new ApiClient({
      baseUrl: 'https://api.example.test',
      csrfCookieName: 'tm_session_csrf',
      fetch: ((input: RequestInfo | URL) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              !OURS.test(String(input))
                ? { error: { code: 'not_found', message: 'none' } }
                : String(input).includes('/members')
                  ? { members: MEMBERS, nextAfter: null }
                  : String(input).endsWith('/people')
                    ? {
                        doerUserIds: ownerUserId === null ? [] : [ownerUserId],
                        supervisorUserIds: [],
                        watcherUserIds: [],
                      }
                    : {
                        id: 'wi-1',
                        projectId: 'proj-1',
                        type: 'task',
                        title: 'Draft the homepage copy',
                        state: 'in_progress',
                        ownerUserId,
                        audience: 'internal',
                        startAt: null,
                        dueAt: null,
                        completedAt: null,
                        version: 3,
                        createdAt: '2026-08-26T00:00:00.000Z',
                        updatedAt: '2026-08-28T00:00:00.000Z',
                        deletedAt: null,
                      },
            ),
            {
              status: OURS.test(String(input)) ? 200 : 404,
              headers: { 'content-type': 'application/json' },
            },
          ),
        )) as typeof globalThis.fetch,
      readCsrfToken: () => 'csrf-token',
      newCorrelationId: () => 'correlation-fixed',
    });

    const queries = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    render(
      <QueryClientProvider client={queries}>
        <WorkItemDetailScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          workItemId="wi-1"
          client={client}
        />
      </QueryClientProvider>,
    );
  }

  it('says who is accountable by name, not that somebody is "Assigned"', async () => {
    renderDetail('u-omar');
    await waitFor(() => expect(screen.getByText('Omar Haddad')).toBeInTheDocument());
    expect(screen.queryByText('Assigned')).not.toBeInTheDocument();
  });

  it('offers to add a doer when nobody owns it', async () => {
    renderDetail(null);
    expect(await screen.findByRole('button', { name: 'Doers Add' })).toBeInTheDocument();
  });
});
