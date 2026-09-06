'use client';

import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, type ReactNode } from 'react';
import { authBoundary, type AuthBoundary, type AuthNotice } from '../../lib/auth-boundary';

/**
 * What a change of principal does to this tab — review finding D01.
 *
 * Listens on the authentication boundary and, on every notice:
 *
 * 1. **cancels** every in-flight query, so a response that was requested as the previous
 *    person cannot land in the cache after the next person has arrived — TanStack discards a
 *    cancelled fetch's result even though the network request completes;
 * 2. **clears** the query and mutation caches — every organization, work, portal and session
 *    entry, whatever its key, because none of the keys names the person;
 * 3. **navigates to sign-in** when the session ended without this tab asking: the API refused
 *    it and the refresh could not recover it, or another tab signed out. A local sign-out is
 *    navigated by the page that performed it, and a sign-in — local or remote — is not
 *    navigated at all: the screen the person is on refetches as the new person, through the
 *    ordinary authorized reads, and shows whatever that person is allowed to see.
 *
 * The hook is separate from the provider so a test can drive it with its own `QueryClient`,
 * boundary and `navigate`; the provider merely binds it to the application's three.
 */
export function useAuthBoundaryEffects(
  queryClient: QueryClient,
  boundary: AuthBoundary,
  navigate: (path: string) => void,
): void {
  useEffect(
    () =>
      boundary.subscribe((notice) => {
        void queryClient.cancelQueries();
        queryClient.clear();
        if (sendsToSignIn(notice)) navigate('/sign-in');
      }),
    [boundary, navigate, queryClient],
  );
}

/** The notices after which this tab has no session to show anything for. */
export function sendsToSignIn({ event, origin }: AuthNotice): boolean {
  if (event === 'session-ended') return true;
  return event === 'signed-out' && origin === 'remote';
}

export function AuthBoundaryProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  // `replace`, not `push`: a page whose session is gone is not a place to come back to.
  const navigate = useCallback((path: string) => router.replace(path), [router]);
  useAuthBoundaryEffects(queryClient, authBoundary, navigate);
  return <>{children}</>;
}
