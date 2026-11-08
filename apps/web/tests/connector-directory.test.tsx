import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConnectorDirectory } from '../src/components/screens/ConnectorDirectory';
import { ApiClient } from '../src/lib/api/client';
import type { ConnectorView } from '../src/lib/api/connectors';

/** 54-01 — Connected apps v2: the connector directory, its states and the API-key install. */

function connector(partial: Partial<ConnectorView>): ConnectorView {
  return {
    key: 'jira',
    name: 'Jira',
    authType: 'api-key',
    scopes: ['read:jira-work'],
    capabilities: ['work.import'],
    scope: 'organization',
    managed: 'framework',
    state: 'not_installed',
    credentialHint: null,
    installedAt: null,
    ...partial,
  };
}

function mount(connectors: readonly ConnectorView[]) {
  const calls: { method: string; url: string; body: string | undefined }[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, url: String(input), body: init?.body as string | undefined });
      const body =
        method === 'POST'
          ? { ...connectors[0], state: 'installed', credentialHint: '1234' }
          : method === 'DELETE'
            ? { ...connectors[0], state: 'not_installed' }
            : { connectors };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: method === 'POST' ? 201 : 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={query}>
      <ConnectorDirectory api={client} organizationSlug="northstar" builtInAnchor="connect-apps" />
    </QueryClientProvider>,
  );
  return calls;
}

describe('ConnectorDirectory (54-01)', () => {
  it('shows the built-in connections with Manage and an API-key connector with Install', async () => {
    mount([
      connector({
        key: 'google_drive',
        name: 'Google Drive',
        authType: 'oauth2',
        managed: 'built-in',
        state: 'connected',
      }),
      connector({}),
    ]);
    expect(await screen.findByText('Google Drive')).toBeTruthy();
    expect(screen.getByText('Connected')).toBeTruthy();
    expect(screen.getByText('Not installed')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Manage' }).getAttribute('href')).toBe('#connect-apps');
    expect(screen.getByRole('button', { name: 'Install Jira' })).toBeTruthy();
  });

  it('installs with the pasted key and shows Installed', async () => {
    const calls = mount([connector({})]);
    fireEvent.click(await screen.findByRole('button', { name: 'Install Jira' }));
    const form = screen.getByRole('form', { name: 'Install Jira' });
    fireEvent.change(within(form).getByLabelText('API token'), {
      target: { value: 'jira-token-abcd1234' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(screen.getByText('Installed')).toBeTruthy());
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.url).toBe(
      'https://api.example.test/v1/organizations/northstar/connectors/jira/install',
    );
    expect(JSON.parse(post?.body ?? '{}')).toEqual({ apiKey: 'jira-token-abcd1234' });
  });

  it('uninstalls an installed connector', async () => {
    const calls = mount([connector({ state: 'installed', credentialHint: '1234' })]);
    fireEvent.click(await screen.findByRole('button', { name: 'Uninstall Jira' }));
    await waitFor(() => expect(screen.getByText('Not installed')).toBeTruthy());
    expect(calls.some((call) => call.method === 'DELETE')).toBe(true);
  });
});
