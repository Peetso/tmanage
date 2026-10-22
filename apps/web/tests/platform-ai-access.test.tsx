import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { PlatformAiAccessScreen } from '../src/components/platform/PlatformAiAccessScreen';

/** P10 — the platform AI kill switch (OPS-2..5). Text may be the key until the P10 fragment is merged. */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ME = {
  email: 'peter@example.com',
  displayName: 'Peter',
  mfaEnabled: true,
  stepUpExpiresAt: new Date(Date.now() + 11 * 60_000).toISOString(),
  stepUpMinutes: 15,
};
const settings = (on: boolean, environmentDisabled = false) => ({
  publicSignup: { open: true, source: 'environment', environmentDefault: true },
  aiAccess: { on, environmentDisabled },
});
const EVENTS = [
  {
    id: 'e1',
    actorEmail: 'peter@example.com',
    action: 'platform.ai_access_on',
    targetType: 'setting',
    targetId: null,
    targetLabel: 'ai_access',
    reason: 'connector launch',
    occurredAt: '2026-10-21T18:42:00Z',
  },
  {
    id: 'e0',
    actorEmail: 'ops@example.com',
    action: 'platform.public_signup_closed',
    targetType: 'setting',
    targetId: null,
    targetLabel: 'public_signup',
    reason: 'unrelated',
    occurredAt: '2026-10-20T10:00:00Z',
  },
];

function mount(routes: { me?: () => Response; on?: boolean; locked?: boolean }) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, path: url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.endsWith('/v1/platform/me')) return Promise.resolve(routes.me ? routes.me() : json(ME));
    if (url.endsWith('/v1/platform/settings')) {
      return Promise.resolve(json(settings(routes.on ?? true, routes.locked ?? false)));
    }
    if (url.endsWith('/v1/platform/audit')) return Promise.resolve(json({ events: EVENTS }));
    if (url.endsWith('/v1/platform/settings/ai-access'))
      return Promise.resolve(json(settings(false)));
    return Promise.resolve(json({ error: { code: 'not_found', message: 'x' } }, 404));
  }) as typeof globalThis.fetch;
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: fetchImpl,
    readCsrfToken: () => 'csrf',
    newCorrelationId: () => 'c',
  });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <PlatformAiAccessScreen client={client} />
    </QueryClientProvider>,
  );
  return calls;
}

describe('Platform AI access', () => {
  it('shows the switch on with the last change from the audit log', async () => {
    mount({});
    const last = await screen.findByTestId('ai-access-last-change');
    expect(last.textContent).toContain('peter@example.com');
    expect((screen.getByRole('switch') as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByText('unrelated', { exact: false })).toBeNull();
  });

  it('turning off needs a reason, then PUTs on=false', async () => {
    const calls = mount({});
    fireEvent.click(await screen.findByRole('switch'));
    const dialog = screen.getByRole('dialog');
    const confirm = within(dialog).getByRole('button', {
      name: /Turn off AI|AiAccess.turnOffConfirm/,
    });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'security review' } });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')).toMatchObject({
        path: 'https://api.example.test/v1/platform/settings/ai-access',
        body: { on: false, reason: 'security review' },
      }),
    );
  });

  it('locks the switch when the server keeps AI off', async () => {
    mount({ on: false, locked: true });
    const toggle = (await screen.findByRole('switch')) as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
    expect(toggle.checked).toBe(false);
  });

  it('shows not-found to anyone the API does not list', async () => {
    mount({ me: () => json({ error: { code: 'not_found', message: 'x' } }, 404) });
    expect(
      await screen.findByText(/This page does not exist|AiAccess.pageDoesNotExist/),
    ).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
  });
});
