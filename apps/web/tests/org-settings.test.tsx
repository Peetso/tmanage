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
      if (url.pathname === `${base}/logo` && method === 'PUT') {
        profile = { ...profile, logoFileId: (body as { fileId: string }).fileId };
        return json(profile);
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

function renderScreen(api = fakeApi(), uploadLogo?: (file: File) => Promise<string>) {
  const view = render(
    withQuery(
      <OrgSettingsScreen
        organizationSlug="northstar-studio"
        organizationName="Northstar Studio"
        client={api.client}
        {...(uploadLogo ? { uploadLogo } : {})}
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

  it('Upload logo uploads the file and sets it as the logo', async () => {
    const uploaded: string[] = [];
    const { api, container } = renderScreen(fakeApi(), (file) => {
      uploaded.push(file.name);
      return Promise.resolve('file-logo-1');
    });
    await screen.findByLabelText('Organization name');
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'logo.png', { type: 'image/png' })] },
    });

    await waitFor(() =>
      expect(api.calls).toContainEqual({
        method: 'PUT',
        path: '/v1/organizations/northstar-studio/logo',
        body: { fileId: 'file-logo-1' },
      }),
    );
    expect(uploaded).toEqual(['logo.png']);
    expect(await screen.findByRole('button', { name: 'Remove' })).toBeInTheDocument();
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
