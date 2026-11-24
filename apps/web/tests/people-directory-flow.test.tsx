import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { PeopleDirectoryScreen } from '../src/components/screens/PeopleDirectoryScreen';
import { expectNoAxeViolations } from './axe';

/**
 * People & capacity (module 14, audit #4). The screen reads a single endpoint; the fake fetch
 * returns one body/status so the read can be given a success body or a refusal the way a caller
 * actually experiences it.
 */
type Reply = { body: unknown; status?: number };

function mount(reply: Reply) {
  const routed: typeof globalThis.fetch = ((input: RequestInfo | URL) =>
    Promise.resolve(
      // Plan 60: AI employees are not offered here (the API answers 404 while they are off).
      String(input).includes('/ai-employees')
        ? new Response(JSON.stringify({ error: { code: 'not_found', message: 'Not found' } }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          })
        : new Response(JSON.stringify(reply.body), {
            status: reply.status ?? 200,
            headers: { 'content-type': 'application/json' },
          }),
    )) as typeof globalThis.fetch;

  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: routed,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={query}>
      <PeopleDirectoryScreen
        organizationSlug="northstar"
        organizationName="Northstar Studio"
        client={client}
      />
    </QueryClientProvider>,
  );
}

const PEOPLE = {
  people: [
    {
      userId: 'u-1',
      displayName: 'Priya Raman',
      role: 'manager',
      status: 'active',
      projectCount: 3,
    },
    { userId: 'u-2', displayName: 'Bo Nguyen', role: 'guest', status: 'active', projectCount: 0 },
  ],
  nextAfter: null,
};

describe('PeopleDirectoryScreen', () => {
  it('lists the organization members by name with their project count, accessibly', async () => {
    const { container } = mount({ body: PEOPLE });

    // A1 (r-people): the roster is a table; the role controls are A1's own tests.
    const table = await screen.findByRole('table', { name: /people in this organization/i });
    const rows = within(table);
    expect(rows.getByText('Priya Raman')).toBeTruthy();
    await expectNoAxeViolations(container);

    // Plan 60 S1: the project count is drawn on the grid cards.
    fireEvent.click(screen.getByRole('radio', { name: 'Grid' }));
    expect(screen.getByText('3 projects')).toBeTruthy();
    expect(screen.getByText('0 projects')).toBeTruthy();
    // The view choice is saved per workspace; put the list back for the next test.
    fireEvent.click(screen.getByRole('radio', { name: 'List' }));
  });

  it('offers no role controls or invite to someone whose role is not known to assign', async () => {
    mount({ body: { ...PEOPLE, people: [{ ...PEOPLE.people[0], membershipId: 'm-1' }] } });

    await screen.findByRole('table', { name: /people in this organization/i });
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Change role/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Priya Raman' }));
    expect(screen.getByRole('menuitem', { name: 'View profile' }).getAttribute('href')).toBe(
      '/northstar/people/m-1',
    );
  });

  it('draws no empty invitations anchor for someone who does not manage invitations', async () => {
    // QA-FIX-P L8's `#invitations` wrapper, drawn empty, was still a column item and pushed the
    // owner footnote a gap lower for every member (VR people directory, 2026-11-23).
    const { container } = mount({ body: PEOPLE });

    await screen.findByRole('table', { name: /people in this organization/i });
    expect(container.querySelector('#invitations')).toBeNull();
  });

  it('surfaces a work.read refusal rather than rendering blank', async () => {
    mount({
      body: { error: { code: 'forbidden', message: 'You need work.read.', correlationId: 'c' } },
      status: 403,
    });

    expect(await screen.findByText('You need work.read.')).toBeTruthy();
  });
});
