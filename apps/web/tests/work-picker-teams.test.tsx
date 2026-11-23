import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiClient } from '../src/lib/api/client';
import { PickerTeams } from '../src/components/work/PickerTeams';

/**
 * WX2 (Fable WORK-BUILD review, teams in the Work people pickers): a team in the Doers or
 * Watchers picker ticks only the people on the work's project, says how many it left out, hides
 * teams without members or outside the search, and says so when the roster does not load.
 */

const ORG = 'acme';
const base = `/v1/organizations/${ORG}/people/teams`;

const design = {
  id: 'team-design',
  name: 'Design',
  memberCount: 3,
  faces: [],
  createdAt: '2026-11-01T00:00:00.000Z',
};
const empty = { ...design, id: 'team-empty', name: 'Empty', memberCount: 0 };
const growth = { ...design, id: 'team-growth', name: 'Growth', memberCount: 1 };

function member(userId: string) {
  return {
    membershipId: `m-${userId}`,
    userId,
    displayName: userId,
    role: 'member',
    status: 'active',
    openWorkCount: 0,
  };
}

function reply(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
}

function renderTeams(options: { needle?: string; rosterFails?: boolean } = {}) {
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === base) return reply({ teams: [design, empty, growth], peopleCount: 4 });
      if (path === `${base}/${design.id}`) {
        if (options.rosterFails) {
          return reply({ error: { code: 'internal', message: 'down' } }, 500);
        }
        return reply({
          id: design.id,
          name: design.name,
          createdAt: design.createdAt,
          members: [member('u-peter'), member('u-sara'), member('u-outside')],
        });
      }
      return reply({ error: { code: 'not_found', message: 'none' } }, 404);
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf',
    newCorrelationId: () => 'c',
  });
  const onAdd = vi.fn();
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={query}>
      <PickerTeams
        api={client}
        organizationSlug={ORG}
        needle={options.needle ?? ''}
        candidateIds={new Set(['u-peter', 'u-sara', 'u-mona'])}
        onAdd={onAdd}
      />
    </QueryClientProvider>,
  );
  return onAdd;
}

afterEach(cleanup);

describe('teams in the Work people pickers', () => {
  it('adds only the project people of a team and says how many were left out', async () => {
    const onAdd = renderTeams();
    fireEvent.click(await screen.findByRole('button', { name: /Add everyone in Design/u }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledWith(['u-peter', 'u-sara']));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Not added from Design: 1 not in this project.',
    );
  });

  it('lists only teams with members that match the search', async () => {
    renderTeams({ needle: 'gro' });
    expect(await screen.findByRole('button', { name: /Add everyone in Growth/u })).toBeVisible();
    expect(screen.queryByRole('button', { name: /Design/u })).toBeNull();
    expect(screen.queryByRole('button', { name: /Empty/u })).toBeNull();
  });

  it('says so when the team does not load, and adds nobody', async () => {
    const onAdd = renderTeams({ rosterFails: true });
    fireEvent.click(await screen.findByRole('button', { name: /Add everyone in Design/u }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'That team did not load. Try again.',
    );
    expect(onAdd).not.toHaveBeenCalled();
  });
});
