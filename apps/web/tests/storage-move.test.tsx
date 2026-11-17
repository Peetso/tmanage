import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import type { StorageMoveView } from '../src/lib/api/storage-root';
import { storageMoveKeys, useStorageMove } from '../src/lib/use-storage-move';

/** 57-13c — the "Move to Drive" job hook behind the Plan & usage storage card. */
const BASE = 'https://api.example.test/v1/organizations/northstar/integrations/storage';
const JOB_ID = '01933b4e-0000-7000-8000-000000000001';

function job(status: StorageMoveView['status']): StorageMoveView {
  return {
    id: JOB_ID,
    provider: 'google_drive',
    status,
    total: 4,
    moved: status === 'done' ? 4 : 1,
    failed: 0,
    skipped: 0,
    movedBytes: 1024,
    error: null,
    createdAt: '2026-11-17T10:00:00.000Z',
    finishedAt: status === 'done' ? '2026-11-17T10:01:00.000Z' : null,
  };
}

function mount(enabled: boolean, answer: (method: string, url: string) => unknown) {
  const calls: { method: string; url: string; body: string | null }[] = [];
  const api = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const url = String(input);
      calls.push({ method, url, body: typeof init?.body === 'string' ? init.body : null });
      return Promise.resolve(
        new Response(JSON.stringify(answer(method, url)), {
          status: method === 'POST' ? 202 : 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => useStorageMove(api, 'northstar', enabled), { wrapper });
  return { calls, hook, queryClient };
}

describe('useStorageMove', () => {
  it('asks nothing for a person who cannot manage storage', () => {
    const { calls } = mount(false, () => ({ job: null }));
    expect(calls).toHaveLength(0);
  });

  it('starts a move naming only the provider and shows the server job', async () => {
    const { calls, hook } = mount(true, (method) =>
      method === 'POST' ? job('queued') : { job: null },
    );
    await waitFor(() => expect(hook.result.current.isPending).toBe(false));
    act(() => hook.result.current.start('google_drive'));
    await waitFor(() => expect(hook.result.current.job?.status).toBe('queued'));
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.url).toBe(`${BASE}/migration-jobs`);
    expect(JSON.parse(post?.body ?? '{}')).toEqual({ provider: 'google_drive' });
  });

  it('follows a running job by its id until it is done', async () => {
    const { calls, hook, queryClient } = mount(true, (_method, url) =>
      url.endsWith(JOB_ID) ? job('done') : { job: job('running') },
    );
    await waitFor(() => expect(hook.result.current.job?.status).toBe('running'));
    await act(() => queryClient.refetchQueries({ queryKey: storageMoveKeys.latest('northstar') }));
    expect(calls.at(-1)?.url).toBe(`${BASE}/migration-jobs/${JOB_ID}`);
    await waitFor(() => expect(hook.result.current.job?.status).toBe('done'));
  });
});
