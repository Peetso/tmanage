import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import {
  AiAssistantScreen,
  connectionFrom,
  isActive,
} from '../src/components/screens/AiAssistantScreen';
import type { PersonalAccessTokenView } from '../src/lib/api/personal-access-tokens';
import type { ConnectedApp } from '../src/lib/api/connected-apps';
import type { AiApprovalView } from '../src/lib/api/ai-approvals';
import { expectNoAxeViolations } from './axe';

const NOW = new Date('2026-11-18T12:00:00.000Z');

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

function app(overrides: Partial<ConnectedApp> = {}): ConnectedApp {
  return {
    id: 'g1',
    clientName: 'Claude',
    verified: true,
    scopes: ['read'],
    memberName: 'Maya Hassan',
    mine: true,
    connectedAt: '2026-11-18T10:42:00.000Z',
    lastUsedAt: null,
    ...overrides,
  };
}

function approval(id: string, clientName = 'Claude'): AiApprovalView {
  return {
    id,
    status: 'pending',
    clientName,
    memberName: 'Maya Hassan',
    memberEmail: 'maya@example.test',
    summary: {
      opId: 'work_items.delete',
      title: 'Delete a work item',
      method: 'DELETE',
      destructive: true,
      notifies: false,
      subject: null,
      fields: [],
    },
    confirmation: 'none',
    amount: null,
    expiresAt: '2026-11-18T13:00:00.000Z',
    decidedAt: null,
  };
}

interface World {
  tokens?: PersonalAccessTokenView[];
  apps?: ConnectedApp[];
  approvals?: AiApprovalView[];
  refuse?: boolean;
}

function mount(world: World = {}) {
  const urls: string[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      urls.push(`${init?.method ?? 'GET'} ${url}`);
      const json = (status: number, body: unknown) =>
        Promise.resolve(
          new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          }),
        );
      if (world.refuse) {
        return json(403, {
          error: { code: 'forbidden', message: 'No access.', correlationId: 'c' },
        });
      }
      if (url.includes('/oauth/grants')) {
        return json(200, {
          owner: false,
          viewerName: 'Maya',
          aiAccessEnabled: true,
          apps: world.apps ?? [],
        });
      }
      if (url.includes('/ai/approvals')) return json(200, { items: world.approvals ?? [] });
      return json(200, { tokens: world.tokens ?? [] });
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
        pollMs={false}
      />
    </QueryClientProvider>,
  );
  return { ...view, urls };
}

describe('AiAssistantScreen — connect in three steps (55-15p)', () => {
  it('shows the three steps with this deployment address, waits, and is axe-clean', async () => {
    const { container } = mount();

    expect(screen.getByRole('heading', { name: 'AI assistant' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Pick your assistant/u })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Copy one line/u })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Check the connection/u })).toBeTruthy();
    // The address is the deployment's own `/mcp`, never typed by hand.
    expect(screen.getByTestId('tm-ai-line').textContent).toBe('https://tmanage.example.test/mcp');
    expect(screen.getByTestId('tm-ai-line').getAttribute('dir')).toBe('ltr');
    expect(screen.getByRole('button', { name: /Claude/u }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    await waitFor(() =>
      expect(screen.getByTestId('tm-ai-status').textContent).toContain(
        'Waiting for Claude to connect. Keep this page open.',
      ),
    );
    expect(screen.queryByTestId('tm-ai-pending')).toBeNull();
    await expectNoAxeViolations(container);
  });

  it('switches the path and the line per assistant', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'ChatGPT' }));
    expect(screen.getByTestId('tm-ai-path').textContent).toContain('Add custom MCP server');
    expect(screen.getByTestId('tm-ai-line').textContent).toBe('https://tmanage.example.test/mcp');

    fireEvent.click(screen.getByRole('button', { name: 'Cursor' }));
    expect(screen.getByTestId('tm-ai-line').textContent).toBe(
      '"tmanage": { "url": "https://tmanage.example.test/mcp" }',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Another assistant' }));
    expect(screen.getByTestId('tm-ai-path').textContent).toContain('HTTP MCP server');
    expect(document.querySelector('a[href="/northstar/help/connect-ai"]')).not.toBeNull();
    expect(screen.getByTestId('tm-ai-status').textContent).toContain('Another assistant');
  });

  it('says connected once an assistant has signed in as the member', async () => {
    mount({ apps: [app()] });
    await waitFor(() =>
      expect(document.querySelector('.tm-state-capsule--done')?.textContent).toContain('Connected'),
    );
    expect(screen.getByTestId('tm-ai-status').textContent).toContain('It signs in as you.');
    expect(screen.getByTestId('tm-ai-status').textContent).toContain('Claude connected on');
  });

  it('shows the waiting card and sends Review to the one action', async () => {
    mount({ apps: [app()], approvals: [approval('pa-1')] });
    const card = await screen.findByTestId('tm-ai-pending');
    expect(card.textContent).toContain('1 action from Claude is waiting for your approval');
    expect(card.textContent).toContain('Nothing that changes your work runs until you approve it.');
    expect(screen.getByRole('link', { name: 'Review' }).getAttribute('href')).toBe(
      '/northstar/ai/approve/pa-1',
    );
  });

  it('sends Review to the AI actions list when several wait', async () => {
    mount({ approvals: [approval('pa-1'), approval('pa-2')] });
    const card = await screen.findByTestId('tm-ai-pending');
    expect(card.textContent).toContain('2 actions from Claude are waiting for your approval');
    expect(screen.getByRole('link', { name: 'Review' }).getAttribute('href')).toBe(
      '/northstar/settings/ai-actions',
    );
  });

  it('only reads: it creates and approves nothing', async () => {
    const { urls } = mount({ approvals: [approval('pa-1')] });
    await screen.findByTestId('tm-ai-pending');
    expect(urls.every((u) => u.startsWith('GET '))).toBe(true);
  });

  it('renders the API refusal rather than a blank page', async () => {
    mount({ refuse: true });
    await waitFor(() => expect(screen.getByText('No access.')).toBeTruthy());
  });
});

describe('connection', () => {
  it('ignores revoked, expired and unused keys and other members’ apps', () => {
    expect(isActive(token({ revokedAt: '2026-10-02T00:00:00.000Z' }), NOW)).toBe(false);
    expect(isActive(token({ expiresAt: '2026-10-17T00:00:00.000Z' }), NOW)).toBe(false);
    expect(connectionFrom([app({ mine: false })], [token()], NOW)).toBeNull();
  });

  it('names the most recent assistant', () => {
    expect(
      connectionFrom(
        [app({ clientName: 'ChatGPT', connectedAt: '2026-11-10T00:00:00.000Z' })],
        [token({ name: 'Cursor key', lastUsedAt: '2026-11-17T00:00:00.000Z' })],
        NOW,
      ),
    ).toEqual({ client: 'Cursor key', at: '2026-11-17T00:00:00.000Z' });
    expect(connectionFrom([app({ lastUsedAt: '2026-11-18T11:00:00.000Z' })], [], NOW)).toEqual({
      client: 'Claude',
      at: '2026-11-18T11:00:00.000Z',
    });
  });
});
