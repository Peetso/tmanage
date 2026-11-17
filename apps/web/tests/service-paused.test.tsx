import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { describeApiError } from '../src/lib/api/describe-error';
import { ApiClient } from '../src/lib/api/client';
import { ApiRequestError } from '../src/lib/api/errors';
import { isServicePaused } from '../src/lib/api/service-paused';
import { ConnectorDirectory } from '../src/components/screens/ConnectorDirectory';
import { ServicePausedNotice } from '../src/components/screens/ServicePausedNotice';

/** ADMINSVC2/3 — a service the platform switched off reads as paused, never as an error. */

const switchedOff = new ApiRequestError(
  409,
  'conflict',
  'This service is turned off for TManage right now',
  'c',
  [{ field: 'integration', message: 'switched_off' }],
);
const notSetUp = new ApiRequestError(409, 'conflict', 'Google Drive is not set up', 'c', [
  { field: 'storage', message: 'not_configured' },
]);

/** The connector directory for Jira, whose install answers 409 with the given detail. */
function mountJira(detail: { field: string; message: string }) {
  const jira = {
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
  };
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((_input: RequestInfo | URL, init?: RequestInit) => {
      const post = (init?.method ?? 'GET') === 'POST';
      const body = post
        ? { error: { code: 'conflict', message: 'Refused', details: [detail] } }
        : { connectors: [jira] };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: post ? 409 : 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ConnectorDirectory api={client} organizationSlug="northstar" only="jira" />
    </QueryClientProvider>,
  );
}

async function tryConnect(): Promise<HTMLButtonElement> {
  const form = await screen.findByRole('form', { name: 'Connect Jira with a key' });
  fireEvent.change(within(form).getByLabelText('Key'), { target: { value: 'jira-key-1234' } });
  const button = within(form).getByRole<HTMLButtonElement>('button', { name: 'Connect' });
  fireEvent.click(button);
  return button;
}

describe('service paused', () => {
  it('tells "switched off" apart from "not set up yet"', () => {
    expect(isServicePaused(switchedOff)).toBe(true);
    expect(isServicePaused(notSetUp)).toBe(false);
    expect(describeApiError(switchedOff, (_key, english) => english)).toMatch(/Nothing is lost/u);
  });

  it('renders the calm notice', () => {
    render(<ServicePausedNotice service="figma" />);
    expect(screen.getByText('Paused by TManage')).toBeTruthy();
    expect(screen.getByText(/your connection is kept/u)).toBeTruthy();
  });

  it('ADMINSVC3: Connect is disabled and described by the notice while switched off', async () => {
    mountJira({ field: 'integration', message: 'switched_off' });
    const button = await tryConnect();
    await waitFor(() => expect(button.disabled).toBe(true));
    const describedBy = button.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toMatch(/paused this service/u);
  });

  it('ADMINSVC3: Connect stays active for any other refusal', async () => {
    mountJira({ field: 'connector', message: 'not_configured' });
    const button = await tryConnect();
    await waitFor(() => expect(screen.getByText(/Refused|could not|Try again/u)).toBeTruthy());
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute('aria-describedby')).toBe(false);
  });
});
