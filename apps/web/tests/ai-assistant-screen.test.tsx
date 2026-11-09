import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import {
  AiAssistantScreen,
  TOKEN_PLACEHOLDER,
  connectionStatus,
  isActive,
} from '../src/components/screens/AiAssistantScreen';
import type { PersonalAccessTokenView } from '../src/lib/api/personal-access-tokens';
import { expectNoAxeViolations } from './axe';

const NOW = new Date('2026-10-18T12:00:00.000Z');

function token(overrides: Partial<PersonalAccessTokenView> = {}): PersonalAccessTokenView {
  return {
    id: 't1',
    name: 'Claude on my laptop',
    tokenPrefix: 'tmanage_pat_ab12',
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    scopes: ['tmanage:read', 'tmanage:write'],
    ipAllowlist: [],
    ...overrides,
  };
}

interface Call {
  method: string;
  url: string;
  body: string | null;
}

function mount(routes: (call: Call) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        method: init?.method ?? 'GET',
        url: String(input),
        body: typeof init?.body === 'string' ? init.body : null,
      };
      calls.push(call);
      const { status, body } = routes(call);
      return Promise.resolve(
        new Response(body === undefined ? null : JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={query}>
      <AiAssistantScreen
        organizationSlug="northstar"
        organizationName="Northstar Studio"
        client={client}
        serverUrl="https://tmanage.example.test"
        now={() => NOW}
      />
    </QueryClientProvider>,
  );
  return { ...view, calls };
}

describe('AiAssistantScreen', () => {
  it('explains the feature, shows this deployment address, and is axe-clean', async () => {
    const { container } = mount(() => ({ status: 200, body: { tokens: [] } }));

    expect(screen.getByRole('heading', { name: 'AI assistant' })).toBeTruthy();
    expect(screen.getAllByText('https://tmanage.example.test/mcp').length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByText('Not connected')).toBeTruthy());

    // AUT-05: Claude adds TManage as a custom connector and signs in; no file, no key, no snippet.
    expect(screen.getByRole('tab', { name: 'Claude' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByTestId('tm-ai-snippet')).toBeNull();
    expect(container.querySelector('a[href="/northstar/help/connect-ai"]')).not.toBeNull();

    fireEvent.click(screen.getAllByRole('tab')[3]!);
    const snippet = screen.getByTestId('tm-ai-snippet').textContent ?? '';
    expect(snippet).toContain('URL: https://tmanage.example.test/mcp');
    expect(snippet).not.toContain('/path/to/');
    expect(snippet).toContain(TOKEN_PLACEHOLDER);

    await expectNoAxeViolations(container);
  });

  it('switches the instructions per assistant', async () => {
    mount(() => ({ status: 200, body: { tokens: [] } }));
    fireEvent.click(screen.getByRole('tab', { name: 'Claude Code' }));
    // Without a key Claude Code signs in through /mcp, so the command carries no placeholder.
    expect(screen.getByTestId('tm-ai-snippet').textContent).toBe(
      'claude mcp add --transport http tmanage https://tmanage.example.test/mcp',
    );
    // AUT-06: ChatGPT signs in with OAuth; it is never told to use a key as a bearer token.
    fireEvent.click(screen.getByRole('tab', { name: 'ChatGPT' }));
    expect(screen.queryByTestId('tm-ai-snippet')).toBeNull();
    expect(screen.getByRole('tabpanel').textContent?.toLowerCase()).not.toContain('bearer');
    expect(screen.getByRole('tab', { name: 'ChatGPT' }).getAttribute('aria-selected')).toBe('true');
  });

  it('creates no token itself and links to the Access tokens page', async () => {
    const { calls, container } = mount(() => ({ status: 200, body: { tokens: [] } }));
    await waitFor(() => expect(screen.getByText('Not connected')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Create key' })).toBeNull();
    // The page's own link plus the settings menu's "Access tokens" entry (FIX2 item 4).
    expect(
      container.querySelectorAll('a[href="/northstar/settings/security"]').length,
    ).toBeGreaterThanOrEqual(2);
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('shows connected with the last use of an active key', async () => {
    mount(() => ({
      status: 200,
      body: { tokens: [token({ lastUsedAt: '2026-10-18T09:30:00.000Z' })] },
    }));
    const status = await screen.findByTestId('tm-ai-status');
    await waitFor(() => expect(within(status).getByText('Connected')).toBeTruthy());
    expect(status.textContent).toContain('Claude on my laptop');
    expect(screen.queryByRole('button', { name: /Revoke/u })).toBeNull();
  });

  it('renders the API refusal rather than a blank page', async () => {
    mount(() => ({
      status: 403,
      body: { error: { code: 'forbidden', message: 'No access.', correlationId: 'c' } },
    }));
    await waitFor(() => expect(screen.getByText('No access.')).toBeTruthy());
  });
});

describe('connection status', () => {
  it('ignores revoked and expired keys', () => {
    expect(isActive(token({ revokedAt: '2026-10-02T00:00:00.000Z' }), NOW)).toBe(false);
    expect(isActive(token({ expiresAt: '2026-10-17T00:00:00.000Z' }), NOW)).toBe(false);
    expect(isActive(token({ expiresAt: '2026-10-19T00:00:00.000Z' }), NOW)).toBe(true);
  });

  it('reports the most recently used key', () => {
    const status = connectionStatus([
      token({ id: 'a', name: 'old', lastUsedAt: '2026-10-10T00:00:00.000Z' }),
      token({ id: 'b', name: 'new', lastUsedAt: '2026-10-18T00:00:00.000Z' }),
      token({ id: 'c', name: 'unused' }),
    ]);
    expect(status).toEqual({
      kind: 'connected',
      lastUsedAt: '2026-10-18T00:00:00.000Z',
      tokenName: 'new',
    });
    expect(connectionStatus([token()])).toEqual({ kind: 'waiting' });
    expect(connectionStatus([])).toEqual({ kind: 'off' });
  });
});
