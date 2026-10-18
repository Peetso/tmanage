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
    expect(screen.getAllByText('https://tmanage.example.test').length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByText('Not connected')).toBeTruthy());

    const snippet = screen.getByTestId('tm-ai-snippet').textContent ?? '';
    expect(snippet).toContain('"TMANAGE_API_URL": "https://tmanage.example.test"');
    expect(snippet).toContain(TOKEN_PLACEHOLDER);

    await expectNoAxeViolations(container);
  });

  it('switches the instructions per assistant', async () => {
    mount(() => ({ status: 200, body: { tokens: [] } }));
    fireEvent.click(screen.getByRole('tab', { name: 'Claude Code' }));
    expect(screen.getByTestId('tm-ai-snippet').textContent).toContain('claude mcp add tmanage');
    fireEvent.click(screen.getByRole('tab', { name: 'ChatGPT' }));
    expect(screen.queryByTestId('tm-ai-snippet')).toBeNull();
    expect(screen.getByRole('tab', { name: 'ChatGPT' }).getAttribute('aria-selected')).toBe('true');
  });

  it('creates a key, shows it once, and fills it into the settings', async () => {
    let tokens: PersonalAccessTokenView[] = [];
    const { calls } = mount((call) => {
      if (call.method === 'POST') {
        const created = token({ id: 'new', name: 'Laptop' });
        tokens = [created];
        return { status: 201, body: { ...created, token: 'tmanage_pat_secretvalue' } };
      }
      return { status: 200, body: { tokens } };
    });

    await waitFor(() => expect(screen.getByText('Not connected')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Laptop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));

    await waitFor(() =>
      expect(screen.getByTestId('tm-ai-secret').textContent).toBe('tmanage_pat_secretvalue'),
    );
    expect(screen.getByTestId('tm-ai-snippet').textContent).toContain('tmanage_pat_secretvalue');
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.url).toContain('/v1/organizations/northstar/me/personal-access-tokens');
    expect(JSON.parse(post?.body ?? '{}')).toEqual({ name: 'Laptop', expiresInDays: null });
    await waitFor(() => expect(screen.getByText('Waiting for your assistant')).toBeTruthy());
  });

  it('shows connected with the last use, and revokes a key', async () => {
    let tokens = [token({ lastUsedAt: '2026-10-18T09:30:00.000Z' })];
    const { calls } = mount((call) => {
      if (call.method === 'DELETE') {
        tokens = [];
        return { status: 204 };
      }
      return { status: 200, body: { tokens } };
    });

    const status = await screen.findByTestId('tm-ai-status');
    await waitFor(() => expect(within(status).getByText('Connected')).toBeTruthy());
    expect(status.textContent).toContain('Claude on my laptop');

    fireEvent.click(screen.getByRole('button', { name: 'Revoke Claude on my laptop' }));
    await waitFor(() => expect(screen.getByText('Not connected')).toBeTruthy());
    expect(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/t1'))).toBe(true);
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
