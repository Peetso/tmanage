import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntegrationDirectoryScreen } from '../src/components/screens/IntegrationDirectoryScreen';
import { BrandLogo, hasBrandMark } from '../src/components/brand/BrandLogo';
import { ApiClient } from '../src/lib/api/client';

/**
 * Feedback 2026-11-09 item 6 — Control center · Integrations as owner-friendly cards: the official
 * mark, one action per app, "Connect" straight to the provider's consent screen where TManage has
 * the sign-in, "Set up" for apps connected on another page, "Coming soon" otherwise, and the
 * hand-recorded catalog connection behind a closed "Advanced".
 */

interface World {
  driveConfigured?: boolean;
  calendarConfigured?: boolean;
  driveConnected?: boolean;
  /** Status code for the Drive start (200 answers with a Google URL). */
  driveStart?: number;
  /** FIX4 item 6: the server has Figma's own sign-in. */
  figmaOneClick?: boolean;
  /** FIX5 item 6c: the caller is the company owner (seeds the shell's organization list). */
  owner?: boolean;
  /** TESTE2E: the platform switched GitHub off, so its sign-in is not set up and reads paused. */
  githubPaused?: boolean;
}

function mount(world: World = {}) {
  const calls: { method: string; path: string; body: string | undefined }[] = [];
  const answer = (path: string, method: string): [number, unknown] => {
    if (path.endsWith('/integrations/google-drive/connect')) {
      return world.driveStart === 409
        ? [
            409,
            {
              error: {
                code: 'conflict',
                message: 'Google Drive is not set up for TManage yet',
                correlationId: 'c',
                details: [{ field: 'storage', message: 'not_configured' }],
              },
            },
          ]
        : [200, { url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x' }];
    }
    if (path.endsWith('/integrations/google-calendar/connect')) {
      return [200, { url: 'https://accounts.google.com/o/oauth2/v2/auth?scope=calendar' }];
    }
    if (path.endsWith('/integrations/google-drive')) {
      return [
        200,
        {
          configured: world.driveConfigured ?? true,
          pickerAvailable: false,
          storageMode: world.driveConnected ? 'google_drive' : 'tmanage',
          googleDrive: {
            status: world.driveConnected ? 'connected' : 'not_connected',
            accountEmail: world.driveConnected ? 'owner@northstar.test' : null,
            folderPath: null,
            sharedDriveName: null,
          },
        },
      ];
    }
    if (path.endsWith('/integrations/onedrive')) {
      return [
        200,
        {
          configured: false,
          pickerAvailable: false,
          storageMode: 'tmanage',
          oneDrive: {
            status: 'not_connected',
            accountEmail: null,
            folderPath: null,
            driveName: null,
            librariesEnabled: false,
          },
        },
      ];
    }
    if (path.endsWith('/integrations/google-calendar')) {
      return [
        200,
        {
          configured: world.calendarConfigured ?? true,
          google: {
            status: 'not_connected',
            accountEmail: null,
            connectedAt: null,
            lastSyncedAt: null,
            lastErrorCode: null,
          },
        },
      ];
    }
    if (path.endsWith('/integrations/microsoft-calendar')) {
      return [404, { error: { code: 'not_found', message: 'no', correlationId: 'c' } }];
    }
    if (path.endsWith('/connectors')) {
      return [
        200,
        {
          connectors: ['github', 'jira'].map((key) => ({
            key,
            name: key === 'github' ? 'GitHub' : 'Jira',
            authType: 'api-key',
            scopes: ['read'],
            capabilities: [],
            scope: 'organization',
            managed: 'framework',
            state: 'not_installed',
            credentialHint: null,
            installedAt: null,
          })),
        },
      ];
    }
    if (path.includes('/app-connect/')) {
      return [
        200,
        world.githubPaused
          ? {
              provider: 'github',
              setUp: false,
              connected: false,
              account: null,
              channel: null,
              paused: true,
            }
          : { provider: 'github', setUp: true, connected: false, account: null, channel: null },
      ];
    }
    if (path.endsWith('/figma/connection/start')) {
      return [200, { url: 'https://www.figma.com/oauth?client_id=x&state=s' }];
    }
    if (path.endsWith('/figma/connection/complete')) {
      return [200, { status: 'connected', handle: 'lina', tokenHint: 'ab12', oneClick: true }];
    }
    if (path.endsWith('/figma/connection')) {
      return [
        200,
        {
          status: 'not_connected',
          handle: null,
          tokenHint: null,
          oneClick: world.figmaOneClick === true,
        },
      ];
    }
    if (path.endsWith('/automations/apps/zapier/connections') && method === 'POST') {
      return [
        201,
        {
          id: 'conn-1',
          appId: 'zapier',
          label: 'Ops workspace',
          status: 'pending',
          config: {},
          createdAt: '2026-11-09T00:00:00.000Z',
        },
      ];
    }
    if (path.endsWith('/automations/apps')) {
      return [
        200,
        {
          apps: [
            {
              id: 'zapier',
              name: 'Zapier',
              category: 'automation',
              capabilities: ['trigger'],
              connections: [],
            },
          ],
        },
      ];
    }
    return [200, {}];
  };
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const path = new URL(String(input)).pathname;
      calls.push({ method, path, body: init?.body as string | undefined });
      const [status, body] = answer(path, method);
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
  const navigate = vi.fn();
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (world.owner) {
    query.setQueryData(
      ['shell', 'organizations'],
      [
        {
          id: 'org-1',
          slug: 'northstar-studio',
          name: 'Northstar Studio',
          audience: 'internal',
          role: 'owner',
          clientOrganizationName: null,
        },
      ],
    );
  }
  render(
    <QueryClientProvider client={query}>
      <IntegrationDirectoryScreen
        organizationSlug="northstar-studio"
        organizationName="Northstar Studio"
        client={client}
        navigate={navigate}
      />
    </QueryClientProvider>,
  );
  return { calls, navigate };
}

function card(name: string): HTMLElement {
  const heading = screen.getByRole('heading', { level: 3, name });
  return heading.closest('li') as HTMLElement;
}

describe('Integrations cards (feedback 2026-11-09 item 6)', () => {
  it('shows one card per app with its mark, and no technical field until Advanced is opened', async () => {
    mount();
    await screen.findByRole('button', { name: 'Connect Google Drive' });
    for (const name of [
      'Google Drive',
      'OneDrive',
      'Google Calendar',
      'Outlook Calendar',
      'Figma',
      'GitHub',
      'Zapier',
    ]) {
      expect(card(name).querySelector('.tm-brand-logo')).not.toBeNull();
    }
    // The official mark in the brand's own colour, never recoloured.
    const driveMark = card('Google Drive').querySelector('svg');
    expect(driveMark?.getAttribute('fill')).toBe('#4285F4');
    // The old connect form is not on the page.
    expect(screen.queryByLabelText('Connection label')).toBeNull();
    expect(screen.queryByLabelText('App')).toBeNull();
    expect(screen.queryByText('Optional setting (non-secret)')).toBeNull();
  });

  it('starts the real Google Drive sign-in in one click and sends the browser to Google', async () => {
    const { calls, navigate } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Google Drive' }));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        'https://accounts.google.com/o/oauth2/v2/auth?client_id=x',
      ),
    );
    const start = calls.find((call) => call.path.endsWith('/integrations/google-drive/connect'));
    expect(start?.method).toBe('POST');
    expect(JSON.parse(start?.body ?? '{}')).toEqual({ returnTo: 'connected-apps' });
  });

  it('starts the owner’s own Google Calendar sign-in', async () => {
    const { calls, navigate } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Google Calendar' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(navigate.mock.calls[0]?.[0]).toContain('accounts.google.com');
    expect(calls.some((call) => call.path.endsWith('/google-calendar/connect'))).toBe(true);
    expect(within(card('Google Calendar')).getByText(/Just for you/)).toBeTruthy();
  });

  it('says plainly when the server has no Google sign-in, instead of a generic failure', async () => {
    const { navigate } = mount({ driveStart: 409 });
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Google Drive' }));
    expect(await screen.findByText('Google Drive is not available yet')).toBeTruthy();
    expect(screen.queryByText(/That didn.t work/)).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
    // The card stops offering a Connect that cannot work.
    expect(screen.queryByRole('button', { name: 'Connect Google Drive' })).toBeNull();
    expect(within(card('Google Drive')).getByText('Not available yet')).toBeTruthy();
  });

  it('shows "Not available yet" without a Connect button when the provider is not configured', async () => {
    mount({ driveConfigured: false, calendarConfigured: false });
    await waitFor(() =>
      expect(within(card('Google Drive')).getByText('Not available yet')).toBeTruthy(),
    );
    expect(screen.queryByRole('button', { name: 'Connect Google Drive' })).toBeNull();
    expect(within(card('Outlook Calendar')).getByText('Not available yet')).toBeTruthy();
  });

  it('shows who a connected app is signed in as, with Manage to its own page', async () => {
    mount({ driveConnected: true });
    await waitFor(() =>
      expect(within(card('Google Drive')).getByText(/Connected as/)).toBeTruthy(),
    );
    expect(
      within(card('Google Drive'))
        .getByRole('link', { name: 'Manage Google Drive' })
        .getAttribute('href'),
    ).toBe('/northstar-studio/admin/storage');
    // FIX3 item 10: headed with its menu name; the count opens the lede.
    expect(screen.getByRole('heading', { level: 1, name: 'Integrations' })).toBeTruthy();
    expect(screen.getByText(/^One connected\./)).toBeTruthy();
  });

  it('sends apps connected elsewhere to their page, and marks Zapier as coming soon', async () => {
    mount();
    await screen.findByRole('button', { name: 'Connect Google Drive' });
    // Slack and Microsoft Teams were removed (Peter, 2026-11-10): no card offers them.
    expect(screen.queryByText('Slack')).toBeNull();
    expect(screen.queryByText('Microsoft Teams')).toBeNull();
    expect(screen.queryByRole('button', { name: /Connect (Slack|Microsoft Teams)/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /Connect (Slack|Microsoft Teams)/ })).toBeNull();
    // FIX5 item 6c: GitHub and Jira's key flow is for owners and admins; a member is told so
    // instead of a link to a section that is not on their page.
    for (const name of ['GitHub', 'Jira']) {
      expect(
        within(card(name)).getByText('An owner or admin connects this for the company.'),
      ).toBeTruthy();
      expect(within(card(name)).queryByRole('link')).toBeNull();
    }
    const zapier = card('Zapier');
    expect(within(zapier).getByText('Coming soon')).toBeTruthy();
    expect(within(zapier).queryByRole('button')).toBeNull();
    expect(within(zapier).queryByRole('link')).toBeNull();
  });

  it('FIX5 item 6c: lists GitHub and Jira once; Jira’s Connect opens its key panel here', async () => {
    mount({ owner: true });
    const jira = await screen.findByRole('button', { name: 'Connect Jira' });
    await waitFor(() => expect(jira).toBeEnabled());
    // One heading per app on the page: no second "Apps that connect with a key" list.
    expect(screen.getAllByRole('heading', { name: 'Jira' })).toHaveLength(1);
    expect(screen.getAllByRole('heading', { name: 'GitHub' })).toHaveLength(1);
    expect(screen.queryByText('Apps that connect with a key')).toBeNull();
    fireEvent.click(jira);
    expect(await screen.findByRole('form', { name: 'Connect Jira with a key' })).toBeTruthy();
    expect(screen.getAllByRole('heading', { name: 'Jira' })).toHaveLength(1);
    // The subtitle no longer promises one click for every app.
    expect(screen.getByText(/Jira asks once for a key/)).toBeTruthy();
    // The Figma card says what its panel says: the connection is the member's own.
    expect(within(card('Figma')).getByText('Just for you: your own Figma account')).toBeTruthy();
  });

  it('TESTE2E: while GitHub is switched off, "Connect another way" is disabled by the notice', async () => {
    mount({ owner: true, githubPaused: true });
    const other = await within(card('GitHub')).findByRole('button', {
      name: 'Connect another way',
    });
    await waitFor(() => expect(other).toBeDisabled());
    expect(other.getAttribute('aria-describedby')).toBe('tm-service-paused-github');
  });

  it('FIX4 item 6: Figma connects in one click when the server has its sign-in', async () => {
    const { calls, navigate } = mount({ figmaOneClick: true });
    const connect = await screen.findByRole('button', { name: 'Connect Figma' });
    await waitFor(() => expect(connect).toBeEnabled());
    fireEvent.click(connect);
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('https://www.figma.com/oauth?client_id=x&state=s'),
    );
    const start = calls.find((call) => call.path.endsWith('/figma/connection/start'));
    expect(JSON.parse(start?.body ?? '{}')).toEqual({ returnTo: 'integrations' });
    expect(screen.queryByLabelText('Personal access token')).toBeNull();
  });

  it("FIX4 item 6: finishes Figma's return on this page and says it is connected", async () => {
    globalThis.history.replaceState(
      null,
      '',
      '/northstar-studio/automations/apps#figma=complete&code=c1&state=s1',
    );
    const { calls } = mount({ figmaOneClick: true });
    expect(await screen.findByText('Figma is connected.')).toBeTruthy();
    const complete = calls.find((call) => call.path.endsWith('/figma/connection/complete'));
    expect(JSON.parse(complete?.body ?? '{}')).toEqual({ code: 'c1', state: 's1' });
    expect(globalThis.location.hash).toBe('');
  });

  it('FIX4 item 6: without Figma sign-in, Connect opens the key form on this page', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Figma' }));
    expect(await screen.findByLabelText('Personal access token')).toBeTruthy();
  });

  it('keeps the hand-recorded connection behind a closed Advanced section', async () => {
    const { calls } = mount();
    const details = screen.getByText('Advanced').closest('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(calls.some((call) => call.path.endsWith('/automations/apps'))).toBe(false);

    details.open = true;
    fireEvent(details, new Event('toggle'));
    const select = await screen.findByLabelText('App');
    fireEvent.change(select, { target: { value: 'zapier' } });
    fireEvent.change(screen.getByLabelText(/Connection label/), {
      target: { value: 'Ops workspace' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record connection' }));
    expect(await screen.findByText('Connection recorded')).toBeTruthy();
    const post = calls.find(
      (call) => call.method === 'POST' && call.path.endsWith('/apps/zapier/connections'),
    );
    expect(JSON.parse(post?.body ?? '{}')).toEqual({ label: 'Ops workspace', config: {} });
  });
});

describe('BrandLogo', () => {
  it('is decorative next to a name and keeps lettered tiles out of the text', () => {
    const { container } = render(
      <p>
        <BrandLogo brand="onedrive" size={24} />
        OneDrive
      </p>,
    );
    expect(container.textContent).toBe('OneDrive');
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(hasBrandMark('onedrive')).toBe(true);
    expect(hasBrandMark('figma')).toBe(true);
  });

  it('names itself only when it stands alone', () => {
    render(<BrandLogo brand="github" label="GitHub" />);
    expect(screen.getByRole('img', { name: 'GitHub' })).toBeTruthy();
  });
});
