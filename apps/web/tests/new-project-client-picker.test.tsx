import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { FirstProjectScreen } from '../src/components/screens/FirstProjectScreen';
import { ApiClient } from '../src/lib/api/client';

/**
 * PRJ-02 / BK1 — the New project Client picker (Figma t5-c). The API's side (the archived-company
 * 422, the replace-any-share semantics) is proved in `clients.service.bk1.test.ts`; this file proves
 * what the screen sends: the project first, then its client, and a refusal shown beside the field.
 */

interface Call {
  readonly url: string;
  readonly method: string | undefined;
  readonly body: unknown;
}

const ORG = 'https://api.example.test/v1/organizations/northstar';

/** A label as it reads in English, or as its key while the i18n fragment is not merged yet. */
function text(key: string, english: string): RegExp {
  return new RegExp(`^(${english}|${key.replace('.', '\\.')})$`);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
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

function handlerWith(role: string, putClient?: () => Response) {
  return (call: Call): Response => {
    if (call.method === 'POST' && call.url === `${ORG}/projects`) {
      return json(
        { id: 'proj-9', workspaceId: 'ws-1', name: 'Website relaunch', targetDate: null },
        201,
      );
    }
    if (call.method === 'PUT' && call.url === `${ORG}/projects/proj-9/client`) {
      return putClient
        ? putClient()
        : json({
            clients: [
              {
                id: 'pc-1',
                projectId: 'proj-9',
                clientOrganizationId: 'co-1',
                createdAt: '2026-10-22T00:00:00.000Z',
              },
            ],
          });
    }
    if (call.url === `${ORG}/workspaces`) {
      return json({
        workspaces: [{ id: 'ws-1', name: 'Main', createdAt: '2026-09-01T00:00:00.000Z' }],
      });
    }
    if (call.url === `${ORG}/client-organization-options`) {
      return json({
        clientOrganizations: [
          { id: 'co-1', name: 'Atlas Hospitality' },
          { id: 'co-2', name: 'Cedar Foods' },
        ],
      });
    }
    if (call.url === 'https://api.example.test/v1/organizations') {
      return json({
        organizations: [
          {
            id: 'o-1',
            slug: 'northstar',
            name: 'Northstar',
            audience: 'internal',
            role,
            clientOrganizationName: null,
          },
        ],
      });
    }
    return json({});
  };
}

function renderScreen(client: ApiClient, onCreated = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrap = (children: ReactNode) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  render(
    wrap(
      <FirstProjectScreen
        mode="new"
        signedInAs="Omar Haddad"
        organizationSlug="northstar"
        organizationName="Northstar"
        client={client}
        onCreated={onCreated}
      />,
    ),
  );
  return onCreated;
}

async function pickAndCreate(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText(/Project name/), 'Website relaunch');
  await user.click(screen.getByRole('combobox'));
  await user.click(await screen.findByRole('option', { name: 'Atlas Hospitality' }));
  await user.click(screen.getByRole('button', { name: 'Create project' }));
}

describe('PRJ-02 new project client picker', () => {
  it('lists the clients, no client, and Add a new client for org.manage', async () => {
    const user = userEvent.setup();
    const { client } = clientOver(handlerWith('owner'));
    renderScreen(client);

    await waitFor(() => expect(screen.getByRole('combobox')).toBeEnabled());
    await user.click(screen.getByRole('combobox'));
    const names = (await screen.findAllByRole('option')).map((option) => option.textContent);
    expect(names.slice(0, 2)).toEqual(['Atlas Hospitality', 'Cedar Foods']);
    await waitFor(() =>
      expect(
        screen.getByRole('option', {
          name: text('ProjectClient.addClientOption', 'Add a new client'),
        }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByRole('option', {
        name: text('ProjectClient.noClientOption', 'No client — internal project'),
      }),
    ).toBeInTheDocument();
  });

  it('hides Add a new client from a role without org.manage', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientOver(handlerWith('manager'));
    renderScreen(client);

    await waitFor(() =>
      expect(calls.some((call) => call.url === 'https://api.example.test/v1/organizations')).toBe(
        true,
      ),
    );
    await waitFor(() => expect(screen.getByRole('combobox')).toBeEnabled());
    await user.click(screen.getByRole('combobox'));
    await screen.findByRole('option', { name: 'Atlas Hospitality' });
    expect(
      screen.queryByRole('option', {
        name: text('ProjectClient.addClientOption', 'Add a new client'),
      }),
    ).toBeNull();
  });

  it('creates the project, then PUTs its client', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientOver(handlerWith('manager'));
    const onCreated = renderScreen(client);

    await waitFor(() => expect(screen.getByRole('combobox')).toBeEnabled());
    await pickAndCreate(user);

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('proj-9'));
    const writes = calls.filter((call) => call.method === 'POST' || call.method === 'PUT');
    expect(writes.map((call) => `${call.method} ${call.url}`)).toEqual([
      `POST ${ORG}/projects`,
      `PUT ${ORG}/projects/proj-9/client`,
    ]);
    expect(writes[1]?.body).toEqual({ clientOrganizationId: 'co-1' });
  });

  it('shows a 422 for an archived company beside the field and retries without a second project', async () => {
    const user = userEvent.setup();
    let refuse = true;
    const { client, calls } = clientOver(
      handlerWith('manager', () =>
        refuse
          ? json(
              {
                error: {
                  code: 'validation_failed',
                  message: 'That client organization is archived',
                  correlationId: 'c1',
                  details: [{ field: 'clientOrganizationId', message: 'is archived' }],
                },
              },
              422,
            )
          : json({ clients: [] }),
      ),
    );
    const onCreated = renderScreen(client);

    await waitFor(() => expect(screen.getByRole('combobox')).toBeEnabled());
    await pickAndCreate(user);

    expect(await screen.findByText('is archived')).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-invalid', 'true');
    expect(onCreated).not.toHaveBeenCalled();

    refuse = false;
    await user.click(screen.getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('proj-9'));
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });
});
