import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiClient } from '../src/lib/api/client';
import { TeamsScreen } from '../src/components/screens/TeamsScreen';
import {
  addChosen,
  faceInitials,
  filterTeams,
  selectedTeamId,
} from '../src/components/people/teams/teams-model';
import type { TeamListRowView } from '../src/lib/api/people-teams';

/**
 * W-WEB-4 Teams (Figma WV2-05, WV2-06, WV2-09): the list with faces and counts, the chosen team's
 * members, New team with people, rename (a taken name said in place), remove, delete with its
 * confirm, the empty states, and no write control for a role without `org.manage`.
 */

const ORG = 'acme';
const base = `/v1/organizations/${ORG}/people/teams`;

const design = {
  id: 'team-design',
  name: 'Design',
  memberCount: 2,
  faces: [
    { userId: 'u-peter', displayName: 'Peter Kamal' },
    { userId: 'u-sara', displayName: 'Sara Adel' },
  ],
  createdAt: '2026-11-01T00:00:00.000Z',
};
const dev = { ...design, id: 'team-dev', name: 'Development', memberCount: 0, faces: [] };

const designDetail = {
  id: design.id,
  name: design.name,
  createdAt: design.createdAt,
  members: [
    member('m-peter', 'u-peter', 'Peter Kamal', 4),
    member('m-sara', 'u-sara', 'Sara Adel', 3),
  ],
};

function member(membershipId: string, userId: string, displayName: string, open: number) {
  return {
    membershipId,
    userId,
    displayName,
    role: 'member',
    status: 'active',
    openWorkCount: open,
  };
}

const people = [
  { membershipId: 'm-peter', userId: 'u-peter', displayName: 'Peter Kamal' },
  { membershipId: 'm-sara', userId: 'u-sara', displayName: 'Sara Adel' },
  { membershipId: 'm-mona', userId: 'u-mona', displayName: 'Mona Rashad' },
].map((person) => ({ ...person, email: null, role: 'member', roleName: null, projectCount: 0 }));

type Reply = { status: number; body?: unknown };
type Handler = (method: string, path: string, body: unknown) => Reply | undefined;

function mount(handler: Handler, options: { role?: string; teams?: readonly unknown[] } = {}) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, path: url.pathname, body });
      const reply =
        handler(method, url.pathname, body) ?? defaults(method, url.pathname, options.teams);
      return Promise.resolve(
        new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
          status: reply.status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf',
    newCorrelationId: () => 'c',
  });
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  query.setQueryData(
    ['shell', 'organizations'],
    [{ slug: ORG, role: options.role ?? 'owner', capabilities: [] }],
  );
  render(
    <QueryClientProvider client={query}>
      <TeamsScreen organizationSlug={ORG} organizationName="Acme" client={client} />
    </QueryClientProvider>,
  );
  return calls;
}

function defaults(method: string, path: string, teams: readonly unknown[] = [design, dev]): Reply {
  if (method === 'GET' && path === base) return { status: 200, body: { teams, peopleCount: 2 } };
  if (method === 'GET' && path === `${base}/${design.id}`)
    return { status: 200, body: designDetail };
  if (method === 'GET' && path === `${base}/${dev.id}`)
    return { status: 200, body: { ...designDetail, id: dev.id, name: dev.name, members: [] } };
  if (method === 'GET' && path === `/v1/organizations/${ORG}/people`)
    return { status: 200, body: { people, nextAfter: null } };
  return { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } };
}

afterEach(() => cleanup());

describe('Teams page (W-WEB-4)', () => {
  it('lists each team with its faces and count, and opens the first one', async () => {
    mount(() => undefined);
    const list = await screen.findByRole('list', { name: 'Teams' });
    const row = within(list).getByRole('button', { name: /Design/ });
    expect(row.getAttribute('aria-pressed')).toBe('true');
    expect(row.textContent).toContain('PKSA');
    expect(await screen.findByText('2 teams · 2 people')).toBeTruthy();
    const members = await screen.findByRole('list', { name: 'People in Design' });
    expect(within(members).getByRole('link', { name: 'Peter Kamal' })).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'Open their work' })[0]?.getAttribute('href')).toBe(
      `/${ORG}/work?team=${design.id}`,
    );
  });

  it('says a team with no one in it yet, under the add field', async () => {
    mount(() => undefined);
    fireEvent.click(await screen.findByRole('button', { name: /Development/ }));
    expect(await screen.findByText('No one in this team yet. Add people above.')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Add people to Development' })).toBeTruthy();
  });

  it('with no team, teaches what teams are for and offers New team', async () => {
    mount(() => undefined, { teams: [] });
    expect(
      await screen.findByText('Group people who work together. Pick a team when you assign work.'),
    ).toBeTruthy();
    expect(screen.getByText('0 teams')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'New team' }).length).toBeGreaterThan(0);
  });

  it('creates a team and adds the chosen people, one after the other', async () => {
    const calls = mount((method, path) =>
      method === 'POST' && path === base
        ? { status: 201, body: { ...dev, id: 'team-new', name: 'Brand studio' } }
        : method === 'PUT'
          ? { status: 204 }
          : undefined,
    );
    fireEvent.click((await screen.findAllByRole('button', { name: 'New team' }))[0] as HTMLElement);
    const dialog = await screen.findByRole('dialog', { name: 'New team' });
    fireEvent.change(within(dialog).getByLabelText('Name'), {
      target: { value: ' Brand studio ' },
    });
    const people = within(dialog).getByRole('combobox', { name: 'People' });
    fireEvent.focus(people);
    fireEvent.change(people, { target: { value: 'Mon' } });
    fireEvent.click(await within(dialog).findByRole('option', { name: /Mona Rashad/ }));
    expect(within(dialog).getByRole('button', { name: 'Remove Mona Rashad' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create team' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true));
    const writes = calls.filter((call) => call.method !== 'GET');
    expect(writes).toEqual([
      { method: 'POST', path: base, body: { name: 'Brand studio' } },
      { method: 'PUT', path: `${base}/team-new/members/m-mona`, body: undefined },
    ]);
  });

  it('keeps New team open and says so when the name is taken (409)', async () => {
    mount((method) =>
      method === 'POST'
        ? { status: 409, body: { error: { code: 'conflict', message: 'taken' } } }
        : undefined,
    );
    fireEvent.click((await screen.findAllByRole('button', { name: 'New team' }))[0] as HTMLElement);
    const dialog = await screen.findByRole('dialog', { name: 'New team' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Design' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create team' }));
    expect(await within(dialog).findByRole('alert')).toHaveProperty(
      'textContent',
      'A team with this name already exists.',
    );
  });

  it('renames in place, adds and removes a person', async () => {
    const calls = mount((method) =>
      method === 'PATCH'
        ? { status: 200, body: { ...design, name: 'Brand' } }
        : method === 'PUT' || method === 'DELETE'
          ? { status: 204 }
          : undefined,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Rename team' }));
    const box = screen.getByLabelText('Team name');
    fireEvent.change(box, { target: { value: 'Brand' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'PATCH',
        path: `${base}/${design.id}`,
        body: { name: 'Brand' },
      }),
    );

    const add = await screen.findByRole('combobox', { name: 'Add people to Design' });
    fireEvent.focus(add);
    const option = await screen.findByRole('option', { name: /Mona Rashad/ });
    // Peter and Sara are already in the team, so only Mona is offered.
    expect(screen.queryByRole('option', { name: /Peter Kamal/ })).toBeNull();
    fireEvent.click(option);
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'PUT',
        path: `${base}/${design.id}/members/m-mona`,
        body: undefined,
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove Sara Adel from the team' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'DELETE',
        path: `${base}/${design.id}/members/m-sara`,
        body: undefined,
      }),
    );
  });

  it('deletes a team only after the confirm that says its people stay', async () => {
    const calls = mount((method) => (method === 'DELETE' ? { status: 204 } : undefined));
    fireEvent.click(await screen.findByRole('button', { name: 'Team actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete team' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete the Design team?' });
    expect(dialog.textContent).toContain(
      'The 2 people stay in TManage and keep their work. Only the team is removed.',
    );
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete team' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'DELETE',
        path: `${base}/${design.id}`,
        body: undefined,
      }),
    );
  });

  it('draws no write control for a role without org.manage', async () => {
    mount(() => undefined, { role: 'custom-viewer' });
    await screen.findByRole('list', { name: 'People in Design' });
    expect(screen.queryByRole('button', { name: 'New team' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rename team' })).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove .* from the team/ })).toBeNull();
  });

  it('marks Teams in the People menu', async () => {
    mount(() => undefined);
    const current = await screen.findByRole('link', { name: 'Teams' });
    expect(current.getAttribute('aria-current')).toBe('page');
    expect(current.getAttribute('href')).toBe(`/${ORG}/people/teams`);
  });
});

describe('teams model', () => {
  const row = (name: string): TeamListRowView => ({ ...design, id: name, name });

  it('draws one letter for an Arabic name and two for a Latin one', () => {
    expect(faceInitials('Peter Kamal')).toBe('PK');
    expect(faceInitials('بيتر كمال')).toBe('ب');
    expect(faceInitials('  ')).toBe('?');
  });

  it('filters by name and falls back to the first team when the asked one is gone', () => {
    const teams = [row('Design'), row('Development'), row('Marketing')];
    expect(filterTeams(teams, ' dev ').map((team) => team.name)).toEqual(['Development']);
    expect(selectedTeamId(teams, 'Marketing')).toBe('Marketing');
    expect(selectedTeamId(teams, 'gone')).toBe('Design');
    expect(selectedTeamId([], null)).toBeNull();
  });

  it('adds each person once, in the order picked', () => {
    const a = { membershipId: 'a', userId: 'ua', displayName: 'A' };
    const b = { membershipId: 'b', userId: 'ub', displayName: 'B' };
    expect(addChosen([a], [b, a, b]).map((p) => p.membershipId)).toEqual(['a', 'b']);
  });
});
