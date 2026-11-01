import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { OrgSettingsScreen } from '../src/components/screens/OrgSettingsScreen';
import { expectNoAxeViolations } from './axe';

/**
 * A11 — Organization settings card (`fq12-organization-settings`): logo, name and the four
 * "What members can do" switches. One Save writes the name and each changed switch.
 */

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

function fakeApi() {
  const calls: Call[] = [];
  let profile = { name: 'Northstar Studio', logoFileId: null as string | null };
  let logo: { mimeType: string; sizeBytes: number; version: number; updatedAt: string } | null =
    null;
  const settings = new Map<string, string>([
    ['members_can_create_projects', 'true'],
    ['members_can_invite_clients', 'false'],
    ['clients_can_upload_files', 'true'],
    ['require_two_step', 'true'],
  ]);
  const json = (body: unknown) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: string, init?: RequestInit) => {
      const url = new URL(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, path: url.pathname, body });
      const base = '/v1/organizations/northstar-studio';
      if (url.pathname === `${base}/profile`) return json(profile);
      if (url.pathname === base && method === 'PATCH') {
        profile = { ...profile, name: (body as { name: string }).name };
        return json(profile);
      }
      if (url.pathname === `${base}/logo` && method === 'GET') return json({ logo });
      if (url.pathname === `${base}/logo/image` && method === 'PUT') {
        const { mimeType } = body as { mimeType: string; dataBase64: string };
        logo = { mimeType, sizeBytes: 1, version: 1, updatedAt: '2026-10-25T10:00:00.000Z' };
        return json({ logo });
      }
      if (url.pathname === `${base}/logo/image` && method === 'DELETE') {
        logo = null;
        return json({ logo });
      }
      if (url.pathname.startsWith(`${base}/settings/`) && method === 'PUT') {
        settings.set(url.pathname.split('/').pop()!, (body as { value: string }).value);
      }
      return json({ settings: [...settings].map(([key, value]) => ({ key, value })) });
    }) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'correlation-fixed',
  });
  return { client, calls };
}

function withQuery(children: ReactNode, role = 'owner') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(
    ['shell', 'organizations'],
    [{ id: 'o1', slug: 'northstar-studio', name: 'Northstar Studio', audience: 'internal', role }],
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function renderScreen(api = fakeApi()) {
  const view = render(
    withQuery(
      <OrgSettingsScreen
        organizationSlug="northstar-studio"
        organizationName="Northstar Studio"
        client={api.client}
      />,
    ),
  );
  return { ...view, api };
}

describe('OrgSettingsScreen — A11 Organization card', () => {
  it('renders the logo initials, the name and the four switches as stored', async () => {
    const { container } = renderScreen();
    expect(await screen.findByLabelText('Organization name')).toHaveValue('Northstar Studio');
    expect(screen.getByText('NS')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Members can create projects' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Members can invite clients' })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'Clients can upload files' })).toBeChecked();
    expect(
      screen.getByRole('switch', { name: 'Everyone must use two-step sign-in' }),
    ).toBeChecked();
    await expectNoAxeViolations(container);
  });

  it('one Save writes the new name and only the switch that changed', async () => {
    const { api } = renderScreen();
    const field = await screen.findByLabelText('Organization name');
    fireEvent.change(field, { target: { value: 'Northstar Studios' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Members can invite clients' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await screen.findByText('Changes saved');
    const writes = api.calls.filter((call) => call.method !== 'GET');
    expect(writes).toEqual([
      {
        method: 'PATCH',
        path: '/v1/organizations/northstar-studio',
        body: { name: 'Northstar Studios' },
      },
      {
        method: 'PUT',
        path: '/v1/organizations/northstar-studio/settings/members_can_invite_clients',
        body: { value: 'true' },
      },
    ]);
  });

  it('Cancel puts the drafts back without writing', async () => {
    const { api } = renderScreen();
    const toggle = await screen.findByRole('switch', { name: 'Members can create projects' });
    fireEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    // The A11 card's own Cancel (the B5 card below it has one too).
    const card = screen.getByRole('region', { name: 'Organization' });
    fireEvent.click(within(card).getByRole('button', { name: 'Cancel' }));
    expect(toggle).toBeChecked();
    expect(api.calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  it('Upload logo sends the file to the organization logo route, with no project', async () => {
    const { api, container } = renderScreen();
    await screen.findByLabelText('Organization name');
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'logo.webp', { type: 'image/webp' })] },
    });

    await waitFor(() =>
      expect(api.calls).toContainEqual({
        method: 'PUT',
        path: '/v1/organizations/northstar-studio/logo/image',
        body: { mimeType: 'image/webp', dataBase64: 'eA==' },
      }),
    );
    expect(api.calls.some((call) => call.path.endsWith('/projects'))).toBe(false);
    const remove = await screen.findByRole('button', { name: 'Remove' });
    // Remove stays disabled until the upload has finished refreshing the card.
    await waitFor(() => expect(remove).toBeEnabled());
    fireEvent.click(remove);
    await waitFor(() =>
      expect(api.calls).toContainEqual({
        method: 'DELETE',
        path: '/v1/organizations/northstar-studio/logo/image',
        body: undefined,
      }),
    );
  });

  it('refuses a file type the logo cannot be, without a request', async () => {
    const { api, container } = renderScreen();
    await screen.findByLabelText('Organization name');
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'logo.gif', { type: 'image/gif' })] },
    });
    expect(await screen.findByText('Choose a PNG, JPEG, WebP or SVG file.')).toBeInTheDocument();
    expect(api.calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  it('shows the older organization settings and saves only the ones that changed', async () => {
    const { api, container } = renderScreen();
    const week = await screen.findByLabelText('Working week');
    // R9: the searchable picker shows the stored UTC by its label, not its id.
    expect((screen.getByLabelText('Default timezone') as HTMLInputElement).value).toMatch(
      /^\(GMT\+0\) /,
    );
    expect(screen.getByLabelText('How work moves')).toHaveValue('delivery-client-review');
    expect(
      screen.getByRole('switch', { name: 'New projects are visible to clients' }),
    ).not.toBeChecked();
    await expectNoAxeViolations(container);

    fireEvent.change(week, { target: { value: 'sun-thu' } });
    fireEvent.change(screen.getByLabelText('Ask for the password again after (minutes)'), {
      target: { value: '30' },
    });
    fireEvent.click(screen.getByRole('switch', { name: 'New projects are visible to clients' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await screen.findByText('Changes saved');
    expect(api.calls.filter((call) => call.method !== 'GET')).toEqual([
      {
        method: 'PUT',
        path: '/v1/organizations/northstar-studio/settings/working_week',
        body: { value: 'sun-thu' },
      },
      {
        method: 'PUT',
        path: '/v1/organizations/northstar-studio/settings/require_reauth_minutes',
        body: { value: '30' },
      },
      {
        method: 'PUT',
        path: '/v1/organizations/northstar-studio/settings/client_visible_project_default',
        body: { value: 'true' },
      },
    ]);
  });

  it('will not save a re-authentication window the API would refuse', async () => {
    renderScreen();
    const minutes = await screen.findByLabelText('Ask for the password again after (minutes)');
    fireEvent.change(minutes, { target: { value: '2000' } });
    expect(screen.getByText('Enter a whole number from 0 to 1440.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('sends a member to Preferences without reading the settings (ACT-13)', async () => {
    const api = fakeApi();
    const { container } = render(
      withQuery(
        <OrgSettingsScreen
          organizationSlug="northstar-studio"
          organizationName="Northstar Studio"
          client={api.client}
        />,
        'member',
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container).toBeEmptyDOMElement();
    expect(api.calls).toEqual([]);
  });
});
