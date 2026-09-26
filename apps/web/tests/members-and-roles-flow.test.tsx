import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { MembersAndRolesScreen } from '../src/components/screens/MembersAndRolesScreen';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * ADM-02 against the endpoints `ProjectMembersController` delivers. The API's behaviour — the
 * escalation guards, the tenant-scoped resolve, the audit rows — is proved in
 * `apps/api/src/modules/projects/project-members.controller.test.ts`. What only this file proves
 * is what the screen sends and shows: names resolved from the member directory rather than raw
 * ids, the role change posted as a compare-and-swap, and a refusal surfaced rather than swallowed.
 */

interface Call {
  readonly url: string;
  readonly method: string | undefined;
  readonly body: unknown;
}

const PID = 'proj-1';
const MEMBERS_URL = `https://api.example.test/v1/organizations/northstar/projects/${PID}/members`;

const DIRECTORY = {
  members: [
    { userId: 'u-1', displayName: 'Omar Haddad', role: 'owner', status: 'active' },
    { userId: 'u-2', displayName: 'Lina Farah', role: 'member', status: 'active' },
  ],
  nextAfter: null,
};

const PROJECT_MEMBERS = {
  members: [
    {
      projectMembershipId: 'pm-1',
      userId: 'u-1',
      role: 'owner',
      createdAt: '2026-09-02T00:00:00.000Z',
    },
  ],
};

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

/** Route by URL and method: the project roster, the directory, and the three writes. */
function defaultHandler(call: Call): Response {
  const isProjectMembers = call.url.includes(`/projects/${PID}/members`);
  if (call.method === undefined || call.method === 'GET') {
    return isProjectMembers ? json(PROJECT_MEMBERS) : json(DIRECTORY);
  }
  if (call.method === 'POST') {
    return json(
      {
        projectMembershipId: 'pm-2',
        userId: 'u-2',
        role: 'member',
        createdAt: '2026-09-03T00:00:00.000Z',
      },
      201,
    );
  }
  if (call.method === 'PATCH') {
    return json({
      projectMembershipId: 'pm-1',
      userId: 'u-1',
      role: 'manager',
      createdAt: '2026-09-02T00:00:00.000Z',
    });
  }
  return new Response(null, { status: 204 });
}

function withQuery(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function renderScreen(client: ApiClient) {
  return render(
    withQuery(
      <MembersAndRolesScreen
        organizationSlug="northstar"
        organizationName="Northstar"
        projectId={PID}
        client={client}
      />,
    ),
  );
}

describe('ADM-02 members and roles', () => {
  it('shows the roster with names resolved from the member directory', async () => {
    const { client } = clientOver(defaultHandler);
    renderScreen(client);
    // The roster row carries only a userId; the name comes from the directory.
    expect(await screen.findByText('Omar Haddad')).toBeInTheDocument();
  });

  it('adds a member by id and role', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientOver(defaultHandler);
    renderScreen(client);

    await screen.findByText('Omar Haddad');
    // Lina is in the directory but not on the project, so she is an add candidate.
    await user.selectOptions(screen.getByLabelText('Person'), 'u-2');
    await user.click(screen.getByRole('button', { name: 'Add to project' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.url).toBe(MEMBERS_URL);
    expect(post?.body).toEqual({ userId: 'u-2', role: 'member' });
  });

  it('changes a role as a compare-and-swap on the current role', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientOver(defaultHandler);
    renderScreen(client);

    await screen.findByText('Omar Haddad');
    await user.selectOptions(screen.getByLabelText(/Role for Omar Haddad/), 'manager');

    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    const patch = calls.find((call) => call.method === 'PATCH');
    expect(patch?.url).toBe(`${MEMBERS_URL}/pm-1`);
    expect(patch?.body).toEqual({ role: 'manager', expectedRole: 'owner' });
  });

  it('surfaces a refusal from the server rather than swallowing it', async () => {
    const user = userEvent.setup();
    const { client } = clientOver((call) =>
      call.method === 'PATCH'
        ? json(
            {
              error: {
                code: 'forbidden',
                message: 'You do not have permission to perform this action',
                correlationId: 'c1',
              },
            },
            403,
          )
        : defaultHandler(call),
    );
    renderScreen(client);

    await screen.findByText('Omar Haddad');
    await user.selectOptions(screen.getByLabelText(/Role for Omar Haddad/), 'manager');

    expect(await screen.findByText('That change was refused')).toBeInTheDocument();
  });

  it('has no axe violations once loaded', async () => {
    const { client } = clientOver(defaultHandler);
    const { container } = renderScreen(client);
    await screen.findByText('Omar Haddad');
    await expectNoAxeViolations(container);
  });
});
