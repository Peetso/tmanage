import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { FirstProjectScreen } from '../src/components/screens/FirstProjectScreen';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';
import { expectInertUntilAnswered, heldAnswer } from './hydration-gate';

/**
 * `ON-03` against the endpoints PROJ-001 delivered.
 *
 * The API's behaviour — the forecast/committed distinction, the audit row, the cross-tenant
 * workspace refused by a composite key — is proved in
 * `apps/api/test/proj-001-project-creation.db.test.ts`. What only this file can prove is what
 * the screen sends, and that the one word the specification is strict about survives: the date
 * is posted as `targetDate`, never as anything that sounds like a commitment.
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

const WORKSPACES = {
  workspaces: [{ id: 'ws-1', name: 'Northstar Studio', createdAt: '2026-08-26T00:00:00.000Z' }],
};

const CREATED = {
  id: 'proj-1',
  workspaceId: 'ws-1',
  name: 'Atlas Website Relaunch',
  status: 'active',
  ownerUserId: 'user-1',
  committedAt: null,
  forecastAt: '2026-09-30',
  createdAt: '2026-08-26T00:00:00.000Z',
  updatedAt: '2026-08-26T00:00:00.000Z',
  archivedAt: null,
};

/** The default: workspaces on a GET, a created project on a POST. */
function defaultHandler(call: Call): Response {
  return call.method === 'POST' ? json(CREATED, 201) : json(WORKSPACES);
}

function renderScreen(client: ApiClient, onCreated?: (id: string) => void) {
  return render(
    withQuery(
      <FirstProjectScreen
        signedInAs="omar@northstar.studio"
        organizationSlug="northstar"
        client={client}
        {...(onCreated ? { onCreated } : {})}
      />,
    ),
  );
}

async function fillAndSubmit(
  user: ReturnType<typeof userEvent.setup>,
  { name = 'Atlas Website Relaunch', date }: { name?: string; date?: string } = {},
) {
  await screen.findByLabelText(/Project name/);
  await user.type(screen.getByLabelText(/Project name/), name);
  if (date !== undefined) await user.type(screen.getByLabelText(/Target date/), date);
  await user.click(screen.getByRole('button', { name: 'Create project' }));
}

describe('ON-03 create the first project', () => {
  it('fetches the organization’s workspaces before it can submit', async () => {
    const { client, calls } = clientOver(defaultHandler);
    renderScreen(client);

    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0]?.url).toBe('https://api.example.test/v1/organizations/northstar/workspaces');
  });

  /**
   * The same defect x38 fixed on CL-09, here on ON-03. "Create project" already carried
   * `disabled={workspaces.isPending}`; the fields did not. On a cold page a project name typed
   * before React hydrated was held by the DOM only, and hydration re-applied `value=''` and
   * erased it — then the submit guard answered "Enter a project name." over a field that looked
   * filled in. One test for the one behaviour: inert while pending, editable after, and what is
   * typed then stays typed.
   */
  it('takes no word until the workspaces have arrived, so nothing typed is silently wiped', async () => {
    const user = userEvent.setup();
    const held = heldAnswer();
    const { client } = clientOver((call) =>
      call.method === 'POST' ? json(CREATED, 201) : held.after(() => json(WORKSPACES)),
    );
    renderScreen(client);

    const name = screen.getByLabelText(/Project name/);
    await expectInertUntilAnswered(
      [
        name,
        screen.getByLabelText(/Target date/),
        screen.getByRole('button', { name: 'Create project' }),
      ],
      held.answer,
    );

    await user.type(name, 'Atlas Website Relaunch');
    expect(name).toHaveValue('Atlas Website Relaunch');
  });

  it('posts the project to the organization in the route', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    const { client, calls } = clientOver(defaultHandler);
    renderScreen(client, onCreated);

    await fillAndSubmit(user);

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('proj-1'));
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.url).toBe('https://api.example.test/v1/organizations/northstar/projects');
    expect(post?.body).toEqual({ workspaceId: 'ws-1', name: 'Atlas Website Relaunch' });
  });

  /**
   * The one word `22` §3 is strict about. A screen that posted `dueDate` or `deadline` would
   * be describing the same value as a promise, which is exactly what the specification says
   * it is not until a milestone plan confirms it.
   */
  it('sends the date as a target, and nothing that reads as a commitment', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientOver(defaultHandler);
    renderScreen(client);

    await fillAndSubmit(user, { date: '2026-09-30' });

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    const body = calls.find((call) => call.method === 'POST')?.body as Record<string, unknown>;
    expect(body['targetDate']).toBe('2026-09-30');
    expect(Object.keys(body)).not.toContain('committedAt');
    expect(Object.keys(body)).not.toContain('dueDate');
    expect(Object.keys(body)).not.toContain('deadline');
  });

  it('omits the date entirely when none was given', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientOver(defaultHandler);
    renderScreen(client);

    await fillAndSubmit(user);

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    const body = calls.find((call) => call.method === 'POST')?.body as Record<string, unknown>;
    expect(Object.keys(body)).not.toContain('targetDate');
  });

  it('takes the workspace from the list rather than from the person', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientOver((call) =>
      call.method === 'POST'
        ? json(CREATED, 201)
        : json({
            workspaces: [
              { id: 'ws-9', name: 'Only workspace', createdAt: '2026-08-26T00:00:00.000Z' },
            ],
          }),
    );
    renderScreen(client);

    await fillAndSubmit(user);

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    const body = calls.find((call) => call.method === 'POST')?.body as Record<string, unknown>;
    expect(body['workspaceId']).toBe('ws-9');
    // There is no workspace picker on this screen; the value is not a person's choice.
    expect(screen.queryByLabelText(/workspace/i)).toBeNull();
  });

  it('refuses an empty name without sending anything', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientOver(defaultHandler);
    renderScreen(client);

    await screen.findByLabelText(/Project name/);
    await user.click(screen.getByRole('button', { name: 'Create project' }));

    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    expect(screen.getByText(/Enter a project name/)).toBeInTheDocument();
  });

  it('warns about a past date without refusing to send it', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientOver(defaultHandler);
    renderScreen(client);

    await fillAndSubmit(user, { date: '2000-01-01' });

    expect(screen.getByText(/That date has passed/)).toBeInTheDocument();
    // A team importing a project that is already late has a legitimate reason to enter one.
    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
  });

  it('attaches a rejected date to the date field', async () => {
    const user = userEvent.setup();
    const { client } = clientOver((call) =>
      call.method === 'POST'
        ? json(
            {
              error: {
                code: 'validation_failed',
                message: 'The request body is invalid',
                correlationId: 'c1',
                details: [{ field: 'targetDate', message: 'is not a real date' }],
              },
            },
            400,
          )
        : json(WORKSPACES),
    );
    renderScreen(client);

    const user2 = user;
    // A date safely in the future: the client's own past-date warning must not pre-empt the
    // server's field-level rejection this test exercises (the bare literal 2026-09-30 became a
    // past date once the real clock passed it, hiding the server error behind the client warning).
    await fillAndSubmit(user2, { date: '2099-09-30' });

    expect(await screen.findByText('is not a real date')).toBeInTheDocument();
    expect(screen.queryByText('Could not create the project')).toBeNull();
  });

  it('shows a banner for a refusal with no field', async () => {
    const user = userEvent.setup();
    const { client } = clientOver((call) =>
      call.method === 'POST'
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
        : json(WORKSPACES),
    );
    renderScreen(client);

    await fillAndSubmit(user);

    expect(await screen.findByText('Could not create the project')).toBeInTheDocument();
    expect(screen.getByText(/do not have permission/)).toBeInTheDocument();
  });

  it('says so when the organization has no workspace to file into', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientOver((call) =>
      call.method === 'POST' ? json(CREATED, 201) : json({ workspaces: [] }),
    );
    renderScreen(client);

    await fillAndSubmit(user);

    expect(screen.getByText(/no workspace to put a project in/)).toBeInTheDocument();
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('reports a failure to load the organization rather than looking empty', async () => {
    const { client } = clientOver(() =>
      json(
        {
          error: {
            code: 'not_found',
            message: 'No organization matching that identifier is available to you',
            correlationId: 'c1',
          },
        },
        404,
      ),
    );
    renderScreen(client);

    expect(await screen.findByText('Could not load this organization')).toBeInTheDocument();
  });

  /**
   * The two fields the specification lists that this screen still cannot save. Both are
   * stated on the screen rather than quietly dropped.
   */
  it('says which of its fields are still not saved', async () => {
    const { client } = clientOver(defaultHandler);
    renderScreen(client);

    await screen.findByLabelText(/Project name/);
    expect(
      screen.getByText(
        /Not available yet — this screen's client link · a people directory, unscheduled/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/The owner will be you/)).toBeInTheDocument();
  });

  it('has no axe violations once loaded', async () => {
    const { client } = clientOver(defaultHandler);
    const { container } = renderScreen(client);
    await screen.findByLabelText(/Project name/);
    await expectNoAxeViolations(container);
  });
});
