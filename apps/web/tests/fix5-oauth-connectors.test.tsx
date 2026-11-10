import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AppConnectPanel } from '../src/components/screens/AppConnectPanel';
import { INTEGRATION_CARDS } from '../src/components/screens/integration-directory-cards';
import { readAppConnectReturn } from '../src/lib/api/app-connect';
import { ApiClient } from '../src/lib/api/client';

/**
 * FIX5 — one-click Connect for GitHub: the provider's return is finished on the Integrations page,
 * Disconnect asks once and then goes. Slack and Microsoft Teams were removed (Peter, 2026-11-10).
 * No real provider is called: the API is a stand-in that answers by path.
 */

type Answer = (body: unknown) => unknown;

function mount(routes: Record<string, Answer>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = `${url.pathname}${url.search}`;
    calls.push({ method, path, body });
    const key = `${method} ${path}`;
    const answer = routes[key];
    if (!answer) {
      return new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 });
    }
    const answered = answer(body);
    if (answered instanceof Response) return answered;
    return new Response(JSON.stringify(answered), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: fetchImpl,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={query}>
      <AppConnectPanel api={client} organizationSlug="acme" />
    </QueryClientProvider>,
  );
  return calls;
}

const base = '/v1/organizations/acme/app-connect';
const view = (provider: string, connected: boolean, extra: Record<string, unknown> = {}) => ({
  provider,
  setUp: true,
  connected,
  account: null,
  ...extra,
});

afterEach(() => globalThis.history.replaceState(null, '', '/'));

describe('FIX5 one-click connectors', () => {
  it('reads GitHub’s return from the fragment, and no other provider’s', () => {
    expect(readAppConnectReturn('#github=complete&code=c1&state=s1')).toEqual({
      provider: 'github',
      kind: 'complete',
      code: 'c1',
      state: 's1',
    });
    expect(readAppConnectReturn('#github=error')).toEqual({ provider: 'github', kind: 'error' });
    expect(readAppConnectReturn('#github=complete&code=c1')).toEqual({
      provider: 'github',
      kind: 'error',
    });
    expect(readAppConnectReturn('#slack=complete&code=c&state=s')).toBeNull();
    expect(readAppConnectReturn('#teams=error')).toBeNull();
    expect(readAppConnectReturn('#figma=complete&code=c&state=s')).toBeNull();
  });

  it('connects GitHub in one click, with the old way kept for Advanced; no Slack or Teams card', () => {
    const card = INTEGRATION_CARDS.find((c) => c.id === 'github');
    expect(card?.flow).toBe('oauth');
    expect(card?.advancedPath).toBeTruthy();
    expect(card?.what).not.toMatch(/issue|pull request/i);
    const ids: readonly string[] = INTEGRATION_CARDS.map((c) => c.id);
    expect(ids).not.toContain('slack');
    expect(ids).not.toContain('teams');
  });

  it('finishes GitHub’s return under the owner’s session', async () => {
    globalThis.history.replaceState(
      null,
      '',
      '/acme/automations/apps#github=complete&code=c1&state=s1',
    );
    const calls = mount({
      [`GET ${base}/github`]: () => view('github', false),
      [`POST ${base}/github/complete`]: () => view('github', true, { account: 'peter' }),
    });
    expect(await screen.findByText('GitHub is connected.')).toBeTruthy();
    expect(calls.find((c) => c.path === `${base}/github/complete`)?.body).toEqual({
      code: 'c1',
      state: 's1',
    });
    expect(globalThis.location.hash).toBe('');
    expect(calls.some((c) => c.path.includes('/slack') || c.path.includes('/teams'))).toBe(false);
  });

  it('explains a refused GitHub grant that was wider than read:user (security review L4)', async () => {
    globalThis.history.replaceState(
      null,
      '',
      '/acme/automations/apps#github=complete&code=c1&state=s1',
    );
    mount({
      [`GET ${base}/github`]: () => view('github', false),
      [`POST ${base}/github/complete`]: () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'validation_failed',
              message: 'GitHub gave TManage more access than it asks for',
              correlationId: 'c',
              details: [{ field: 'scope', message: 'scope_too_wide' }],
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
    });
    expect(await screen.findByText("GitHub isn't connected")).toBeTruthy();
    expect(
      screen.getByText(
        'GitHub gave TManage more access than it asks for, so TManage refused the connection and gave the access back. Press Connect again and keep the requested access as it is.',
      ),
    ).toBeTruthy();
  });

  it('offers no Slack or Teams webhook path under Advanced', async () => {
    mount({ [`GET ${base}/github`]: () => view('github', false) });
    expect(await screen.findByText('Another way to connect GitHub')).toBeTruthy();
    expect(screen.queryByText(/Slack|Teams/)).toBeNull();
  });

  it('asks once before Disconnect, then disconnects', async () => {
    const calls = mount({
      [`GET ${base}/github`]: () => view('github', true, { account: 'peter' }),
      [`DELETE ${base}/github`]: () => view('github', false),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect GitHub' }));
    expect(
      screen.getByText(
        'TManage forgets its access to your GitHub account. Repository webhooks keep working.',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, disconnect' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.path === `${base}/github`)).toBe(true),
    );
  });
});
