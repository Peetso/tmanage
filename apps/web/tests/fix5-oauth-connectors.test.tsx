import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AppConnectPanel } from '../src/components/screens/AppConnectPanel';
import { INTEGRATION_CARDS } from '../src/components/screens/integration-directory-cards';
import { readAppConnectReturn } from '../src/lib/api/app-connect';
import { ApiClient } from '../src/lib/api/client';

/**
 * FIX5 — one-click Connect for GitHub, Slack and Teams: the provider's return is finished on the
 * Integrations page, Teams gets a team and channel picker, Disconnect asks once and then goes.
 * No real provider is called: the API is a stand-in that answers by path.
 */

const TEAM = '11111111-2222-3333-4444-555555555555';
const CHANNEL = '19:abc@thread.tacv2';

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
    return new Response(JSON.stringify(answer(body)), {
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
  channel: null,
  ...extra,
});

afterEach(() => globalThis.history.replaceState(null, '', '/'));

describe('FIX5 one-click connectors', () => {
  it('reads each provider’s return from the fragment', () => {
    expect(readAppConnectReturn('#github=complete&code=c1&state=s1')).toEqual({
      provider: 'github',
      kind: 'complete',
      code: 'c1',
      state: 's1',
    });
    expect(readAppConnectReturn('#teams=error')).toEqual({ provider: 'teams', kind: 'error' });
    expect(readAppConnectReturn('#slack=complete&code=c1')).toEqual({
      provider: 'slack',
      kind: 'error',
    });
    expect(readAppConnectReturn('#figma=complete&code=c&state=s')).toBeNull();
  });

  it('connects GitHub, Slack and Teams in one click, with the old way kept for Advanced', () => {
    for (const id of ['github', 'slack', 'teams'] as const) {
      const card = INTEGRATION_CARDS.find((c) => c.id === id);
      expect(card?.flow).toBe('oauth');
      expect(card?.advancedPath).toBeTruthy();
    }
  });

  it('finishes Slack’s return and says where notices go', async () => {
    globalThis.history.replaceState(
      null,
      '',
      '/acme/automations/apps#slack=complete&code=c1&state=s1',
    );
    const calls = mount({
      [`GET ${base}/github`]: () => view('github', false),
      [`GET ${base}/slack`]: () => view('slack', false),
      [`GET ${base}/teams`]: () => view('teams', false),
      [`POST ${base}/slack/complete`]: () =>
        view('slack', true, { account: 'Peetrix', channel: 'general' }),
      [`GET ${base}/slack/channels`]: () => ({ channels: [{ id: 'C0GENERAL', name: 'general' }] }),
    });
    expect(
      await screen.findByText('Slack is connected. Notices now go to the channel you picked.'),
    ).toBeTruthy();
    expect(calls.find((c) => c.path === `${base}/slack/complete`)?.body).toEqual({
      code: 'c1',
      state: 's1',
    });
    expect(await screen.findByText('Notices go to #general.')).toBeTruthy();
    expect(globalThis.location.hash).toBe('');
  });

  it('picks a Teams team and channel, then posts notices there', async () => {
    const calls = mount({
      [`GET ${base}/github`]: () => view('github', false),
      [`GET ${base}/slack`]: () => view('slack', false),
      [`GET ${base}/teams`]: () => view('teams', true, { account: 'Peter' }),
      [`GET ${base}/teams/channels`]: () => ({ teams: [{ id: TEAM, name: 'Studio' }] }),
      [`GET ${base}/teams/channels?teamId=${TEAM}`]: () => ({
        channels: [{ id: CHANNEL, name: 'General' }],
      }),
      [`POST ${base}/teams/channels`]: () => ({ id: 'l1', label: 'Studio › General' }),
    });
    const team = (await screen.findByLabelText('Team')) as HTMLSelectElement;
    await screen.findByRole('option', { name: 'Studio' });
    fireEvent.change(team, { target: { value: TEAM } });
    const channel = (await screen.findByLabelText('Channel')) as HTMLSelectElement;
    await screen.findByRole('option', { name: 'General' });
    fireEvent.change(channel, { target: { value: CHANNEL } });
    fireEvent.click(screen.getByRole('button', { name: 'Post notices here' }));
    expect(await screen.findByText('Notices now also go to Studio › General.')).toBeTruthy();
    expect(
      calls.find((c) => c.method === 'POST' && c.path === `${base}/teams/channels`)?.body,
    ).toEqual({
      channelId: CHANNEL,
      teamId: TEAM,
      locale: 'en',
    });
  });

  it('asks once before Disconnect, then disconnects', async () => {
    const calls = mount({
      [`GET ${base}/github`]: () => view('github', true, { account: 'peter' }),
      [`GET ${base}/slack`]: () => view('slack', false),
      [`GET ${base}/teams`]: () => view('teams', false),
      [`DELETE ${base}/github`]: () => view('github', false),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect GitHub' }));
    expect(
      screen.getByText('TManage will stop reading your GitHub issues and pull requests.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, disconnect' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.path === `${base}/github`)).toBe(true),
    );
  });
});
