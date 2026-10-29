import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/lib/api/client';
import { retryAfterMs, useChannelLiveFeed } from '../src/lib/use-channel-live-feed';
import type { LiveCloseEvent, LiveSocket } from '../src/lib/use-channel-live-feed';

/**
 * 51-06's browser half: a socket closed 4429 (the worker's process or member cap) is load, not a
 * verdict — the hook waits the server's `retry-after=` hint and connects again, while `revoked`
 * stays terminal.
 */

class FakeSocket implements LiveSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event?: LiveCloseEvent) => void) | null = null;
  send(): void {}
  close(): void {}
}

const api = {
  request: async () => ({
    data: { ticket: 't', expiresAt: '2026-10-29T00:00:00Z', socketUrl: 'ws://x/realtime' },
  }),
} as unknown as ApiClient;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('useChannelLiveFeed — 51-06 capped sockets', () => {
  it('parses the retry-after hint, and nothing else', () => {
    expect(retryAfterMs('retry-after=5')).toBe(5_000);
    expect(retryAfterMs('retry-after=30')).toBe(30_000);
    expect(retryAfterMs('')).toBeNull();
    expect(retryAfterMs(undefined)).toBeNull();
  });

  it('a 4429 close reconnects after the hinted seconds, not before', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    // Stable across renders: the factory is an effect dependency, as in the screens.
    const factory = (): FakeSocket => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    };
    const onCatchUp = (): void => {};
    const { result } = renderHook(() =>
      useChannelLiveFeed({
        api,
        organizationSlug: 'org',
        conversationId: 'c1',
        enabled: true,
        onCatchUp,
        socketFactory: factory,
        reconnectBaseMs: 1,
      }),
    );
    await flush();
    expect(sockets).toHaveLength(1);

    act(() => sockets[0]?.onclose?.({ code: 4429, reason: 'retry-after=5' }));
    expect(result.current).toBe('retrying');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_900);
    });
    expect(sockets).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    await flush();
    expect(sockets).toHaveLength(2);
  });

  it('revoked stays terminal: no reconnect follows', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    // Stable across renders: the factory is an effect dependency, as in the screens.
    const factory = (): FakeSocket => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    };
    const onCatchUp = (): void => {};
    const { result } = renderHook(() =>
      useChannelLiveFeed({
        api,
        organizationSlug: 'org',
        conversationId: 'c1',
        enabled: true,
        onCatchUp,
        socketFactory: factory,
        reconnectBaseMs: 1,
      }),
    );
    await flush();
    act(() =>
      sockets[0]?.onmessage?.({ data: JSON.stringify({ type: 'revoked', conversationId: 'c1' }) }),
    );
    act(() => sockets[0]?.onclose?.({ code: 1000 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(result.current).toBe('revoked');
    expect(sockets).toHaveLength(1);
  });
});
