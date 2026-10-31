import { describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiClient } from '../src/lib/api/client';
import type { StorageStatusView } from '../src/lib/api/google-drive';
import type { OneDriveStatusView } from '../src/lib/api/onedrive';
import { attachStorageState, isFirstTimeStorage } from '../src/lib/storage-attach-state';
import { NoStorageAttach } from '../src/components/storage/NoStorageAttach';

/**
 * Owner decision 2026-10-26 (TManage storage restored 2026-10-31): Control › Storage opens
 * on the first-time choice (Figma 419:23593 / 419:23699) and, with no storage chosen, the attach
 * area shows Connect storage to an owner (419:23811) and Ask your admin to anyone else (419:23844).
 */
const drive = (mode: string, state: string) =>
  ({ storageMode: mode, googleDrive: { status: state } }) as unknown as StorageStatusView;
const oneDrive = (mode: string, state: string) =>
  ({ storageMode: mode, oneDrive: { status: state } }) as unknown as OneDriveStatusView;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('storage states', () => {
  it('keeps the attach controls while the storage status is unknown', () => {
    expect(attachStorageState(undefined, true)).toBe('unknown');
    expect(attachStorageState(undefined, false)).toBe('unknown');
  });

  it('allows attaching once Google Drive or OneDrive is the company storage', () => {
    expect(attachStorageState(drive('google_drive', 'connected'), false)).toBe('ready');
    expect(attachStorageState(drive('onedrive', 'not_connected'), false)).toBe('ready');
  });

  // Owner decision 2026-10-31: TManage storage (1 GB) is offered again and is the default, so a
  // company on TManage storage can attach, and Control › Storage never forces the first-time choice.
  it('allows attaching on TManage storage, for owners and members alike', () => {
    expect(attachStorageState(drive('tmanage', 'not_connected'), true)).toBe('ready');
    expect(attachStorageState(drive('tmanage', 'connected'), false)).toBe('ready');
  });

  it('never opens Control › Storage on the forced first-time choice', () => {
    expect(
      isFirstTimeStorage(drive('tmanage', 'not_connected'), oneDrive('tmanage', 'not_connected')),
    ).toBe(false);
    expect(
      isFirstTimeStorage(drive('onedrive', 'not_connected'), oneDrive('onedrive', 'connected')),
    ).toBe(false);
  });
});

function withQuery(children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('Attach · no storage yet', () => {
  it('links an owner to Control › Storage', () => {
    const client = new ApiClient({
      baseUrl: 'https://app.example.test',
      csrfCookieName: 'c',
      readCsrfToken: () => 't',
      newCorrelationId: () => 'id-0',
      fetch: (() => Promise.resolve(json({}))) as typeof globalThis.fetch,
    });
    render(
      withQuery(<NoStorageAttach organizationSlug="northstar" client={client} state="connect" />),
    );
    expect(screen.getByRole('link', { name: 'Connect storage' })).toHaveAttribute(
      'href',
      '/northstar/admin/storage',
    );
  });

  it('asks the owner by direct message for a member', async () => {
    const calls: string[] = [];
    const client = new ApiClient({
      baseUrl: 'https://app.example.test',
      csrfCookieName: 'c',
      readCsrfToken: () => 't',
      newCorrelationId: () => 'id-1',
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        const path = new URL(String(input)).pathname;
        calls.push(`${method} ${path}`);
        if (path.endsWith('/people')) {
          return Promise.resolve(
            json({
              people: [
                { userId: 'u-2', displayName: 'Omar Said', role: 'member', status: 'active' },
                { userId: 'u-1', displayName: 'Maya Hassan', role: 'owner', status: 'active' },
              ],
              nextAfter: null,
            }),
          );
        }
        if (method === 'POST' && path.endsWith('/direct-conversations')) {
          return Promise.resolve(json({ id: 'dc-1', otherUserId: 'u-1' }, 201));
        }
        return Promise.resolve(json({ id: 'dm-1' }, 201));
      }) as typeof globalThis.fetch,
    });
    render(withQuery(<NoStorageAttach organizationSlug="northstar" client={client} state="ask" />));
    expect(await screen.findByText('We’ll let Maya Hassan know.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ask your admin' }));
    expect(await screen.findByText('Maya Hassan has been asked.')).toBeInTheDocument();
    await waitFor(() =>
      expect(calls).toContain(
        'POST /v1/organizations/northstar/direct-conversations/dc-1/messages',
      ),
    );
  });
});
