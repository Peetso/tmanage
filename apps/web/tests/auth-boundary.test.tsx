import { QueryClient } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  sendsToSignIn,
  useAuthBoundaryEffects,
} from '../src/components/providers/AuthBoundaryProvider';
import { AuthBoundary, type AuthChannel, type AuthNotice } from '../src/lib/auth-boundary';

/**
 * Review finding D01 (2026-09-05): signing out kept the previous person's cached rows for
 * the next person to sign in on the same browser. The boundary and its effects are exercised
 * here exactly as the review's probe exercised the old behaviour: real `QueryClient`
 * operations, synthetic data, no network.
 */

/** A `BroadcastChannel` for two tabs that live in the same test. */
function pairOfChannels(): [AuthChannel, AuthChannel, (raw: unknown) => void] {
  const listeners: [
    ((event: { data: unknown }) => void)[],
    ((event: { data: unknown }) => void)[],
  ] = [[], []];
  const channel = (mine: 0 | 1): AuthChannel => ({
    postMessage: (message) => {
      for (const listener of listeners[mine === 0 ? 1 : 0]) listener({ data: message });
    },
    addEventListener: (_type, listener) => {
      listeners[mine].push(listener);
    },
    removeEventListener: (_type, listener) => {
      listeners[mine] = listeners[mine].filter((candidate) => candidate !== listener);
    },
  });
  const injectIntoSecond = (raw: unknown): void => {
    for (const listener of listeners[1]) listener({ data: raw });
  };
  return [channel(0), channel(1), injectIntoSecond];
}

describe('AuthBoundary', () => {
  it('delivers a local announcement synchronously, then to the other tab as remote', () => {
    const [mine, theirs] = pairOfChannels();
    const here = new AuthBoundary(mine);
    const there = new AuthBoundary(theirs);
    const heard: AuthNotice[] = [];
    const heardThere: AuthNotice[] = [];
    here.subscribe((notice) => heard.push(notice));
    there.subscribe((notice) => heardThere.push(notice));

    here.announce('signed-out');

    expect(heard).toEqual([{ event: 'signed-out', origin: 'local' }]);
    expect(heardThere).toEqual([{ event: 'signed-out', origin: 'remote' }]);
  });

  it('acts only on the three known words from the channel', () => {
    const [, theirs, inject] = pairOfChannels();
    const there = new AuthBoundary(theirs);
    const heard: AuthNotice[] = [];
    there.subscribe((notice) => heard.push(notice));

    inject({ event: 'format-disk' });
    inject('signed-out');
    inject(null);
    inject({ event: 'session-ended', extra: 'ignored' });

    expect(heard).toEqual([{ event: 'session-ended', origin: 'remote' }]);
  });

  it('unsubscribes', () => {
    const boundary = new AuthBoundary();
    const listener = vi.fn();
    const stop = boundary.subscribe(listener);
    stop();
    boundary.announce('signed-in');
    expect(listener).not.toHaveBeenCalled();
  });

  it('lets every listener run even when one throws', () => {
    const boundary = new AuthBoundary();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const second = vi.fn();
    boundary.subscribe(() => {
      throw new Error('a listener failed');
    });
    boundary.subscribe(second);

    boundary.announce('signed-out');

    expect(second).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('works with no channel at all', () => {
    const boundary = new AuthBoundary();
    const listener = vi.fn();
    boundary.subscribe(listener);
    boundary.announce('session-ended');
    expect(listener).toHaveBeenCalledWith({ event: 'session-ended', origin: 'local' });
  });
});

describe('what a change of principal does to the caches', () => {
  function cacheWith(): {
    queryClient: QueryClient;
    boundary: AuthBoundary;
    navigate: ReturnType<typeof vi.fn>;
  } {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: 30_000, retry: false } },
    });
    const boundary = new AuthBoundary();
    const navigate = vi.fn();
    renderHook(() => useAuthBoundaryEffects(queryClient, boundary, navigate));
    return { queryClient, boundary, navigate };
  }

  it('clears every cached query on sign-out, whatever its key — the review probe, inverted', () => {
    const { queryClient, boundary } = cacheWith();
    queryClient.setQueryData(['organizations'], ['SYNTHETIC USER A PRIVATE ORGANIZATION']);
    queryClient.setQueryData(
      ['work-items', 'review-org', 'list', '', ''],
      ['SYNTHETIC USER A PRIVATE WORK'],
    );
    queryClient.setQueryData(['sessions', 'devices'], []);

    boundary.announce('signed-out');

    expect(queryClient.getQueryData(['organizations'])).toBeUndefined();
    expect(queryClient.getQueryData(['work-items', 'review-org', 'list', '', ''])).toBeUndefined();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  });

  it('clears on sign-in too, so the next person starts from nothing', () => {
    const { queryClient, boundary } = cacheWith();
    queryClient.setQueryData(['organizations'], ['A']);
    boundary.announce('signed-in');
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it('does not let a response requested as the previous person land after the boundary', async () => {
    const { queryClient, boundary } = cacheWith();
    let answer!: (rows: string[]) => void;
    const slow = new Promise<string[]>((resolve) => {
      answer = resolve;
    });

    // Person A's read is in flight when A signs out and B signs in.
    const inFlight = queryClient.fetchQuery({ queryKey: ['organizations'], queryFn: () => slow });
    boundary.announce('signed-out');
    boundary.announce('signed-in');

    // The network answers late, with A's rows.
    answer(["A'S ORGANIZATION"]);
    await inFlight.catch(() => undefined);
    await Promise.resolve();

    expect(queryClient.getQueryData(['organizations'])).toBeUndefined();

    // B's own read is what populates the cache.
    const rows = await queryClient.fetchQuery({
      queryKey: ['organizations'],
      queryFn: () => Promise.resolve(["B'S ORGANIZATION"]),
    });
    expect(rows).toEqual(["B'S ORGANIZATION"]);
    expect(queryClient.getQueryData(['organizations'])).toEqual(["B'S ORGANIZATION"]);
  });

  it('sends the tab to sign-in when the session ended or another tab signed out', () => {
    const { boundary, navigate } = cacheWith();

    boundary.announce('signed-out'); // local: the page that signed out navigates itself
    boundary.announce('signed-in');
    expect(navigate).not.toHaveBeenCalled();

    boundary.announce('session-ended');
    expect(navigate).toHaveBeenCalledWith('/sign-in');
  });

  it('decides the navigation by event and origin', () => {
    expect(sendsToSignIn({ event: 'session-ended', origin: 'local' })).toBe(true);
    expect(sendsToSignIn({ event: 'session-ended', origin: 'remote' })).toBe(true);
    expect(sendsToSignIn({ event: 'signed-out', origin: 'remote' })).toBe(true);
    expect(sendsToSignIn({ event: 'signed-out', origin: 'local' })).toBe(false);
    expect(sendsToSignIn({ event: 'signed-in', origin: 'local' })).toBe(false);
    expect(sendsToSignIn({ event: 'signed-in', origin: 'remote' })).toBe(false);
  });

  it('stops listening when the provider unmounts', () => {
    const queryClient = new QueryClient();
    const boundary = new AuthBoundary();
    const navigate = vi.fn();
    const { unmount } = renderHook(() => useAuthBoundaryEffects(queryClient, boundary, navigate));
    unmount();
    boundary.announce('session-ended');
    expect(navigate).not.toHaveBeenCalled();
  });
});
