import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import type { PlatformMeView } from '../src/lib/api/platform-admin';
import type { KeyPurposeView, PlatformKeysView } from '../src/lib/api/platform-keys';
import { PlatformKeysScreen } from '../src/components/platform/settings/PlatformKeysScreen';

/** 56-02 · Settings → Keys: status only, rotation progress, Rotate queues the job. */

afterEach(cleanup);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ME: PlatformMeView = {
  email: 'peter@peetrix.com',
  displayName: 'Peter',
  mfaEnabled: true,
  stepUpNeedsAuthenticatorCode: true,
  stepUpExpiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
  stepUpMinutes: 15,
  source: 'env',
  preset: 'super_admin',
  permissions: ['platform.settings.edit'],
  supportSessions: [],
};

const purpose = (over: Partial<KeyPurposeView>): KeyPurposeView => ({
  purpose: 'mfa',
  activeKeyId: '2',
  keysInRing: 2,
  rowsOnOldKey: 0,
  lastRotationAt: '2026-10-12T10:00:00Z',
  rotatable: false,
  rotation: null,
  ...over,
});
const RUNNING = {
  id: 'r1',
  purpose: 'storage_token',
  fromKeyId: '1',
  toKeyId: '2',
  status: 'running' as const,
  rowsTotal: 5120,
  rowsProcessed: 3500,
  rowsFailed: 0,
  createdAt: '2026-10-29T09:12:00Z',
  startedAt: '2026-10-29T09:12:00Z',
  finishedAt: null,
};
const VIEW: PlatformKeysView = {
  enabled: true,
  activeKeyId: '2',
  keyIds: ['1', '2'],
  mfaFallback: false,
  purposes: [
    purpose({ purpose: 'storage_token', rotatable: true, rowsOnOldKey: 1620, rotation: RUNNING }),
    purpose({ purpose: 'calendar_token', rotatable: true }),
    purpose({ purpose: 'mfa' }),
  ],
  rotation: RUNNING,
  lastRotationAt: '2026-10-12T10:00:00Z',
  nextRotationDueAt: '2027-01-12T10:00:00Z',
  sessions: { keysInRing: 1, overlap: false },
};

function mount() {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace('https://api.example.test', '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path, body });
    if (path === '/v1/platform/me') return Promise.resolve(json(ME));
    if (path === '/v1/platform/keys/status' || path === '/v1/platform/keys/rotate') {
      return Promise.resolve(json(VIEW));
    }
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
      <PlatformKeysScreen client={client} />
    </QueryClientProvider>,
  );
  return calls;
}

describe('56-02 · Keys', () => {
  it('shows progress and queues a rotation for a purpose after confirming', async () => {
    const calls = mount();
    expect(await screen.findByText(/3,500 of 5,120 rows re-encrypted · 68%/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rotating…' })).toHaveProperty('disabled', true);
    expect(screen.queryByRole('textbox')).toBeNull();
    const row = screen.getByText('Calendars (Google, Outlook)').closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Rotate' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Rotate' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'POST',
        path: '/v1/platform/keys/rotate',
        body: { purpose: 'calendar_token' },
      }),
    );
  });
});
