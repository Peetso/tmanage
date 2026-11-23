'use client';

import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, type ReactNode } from 'react';
import { authBoundary, type AuthBoundary, type AuthNotice } from '../../lib/auth-boundary';
import { browserApiClient } from '../../lib/api/browser-client';
import { isAccessExpired, type ApiClient } from '../../lib/api/client';
import { signInPathFor } from '../../lib/sign-in-return';
import { IdleSignOutWarning } from './IdleSignOutWarning';

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
        // AUTHSTATE: on an entry page already, the page's own session check shows the form; a
        // navigation to `/sign-in` from there would only drop its `?next=`.
        if (sendsToSignIn(notice) && !isEntryPage(currentPathname())) {
          // An invitation page (ACC-01) or the AI-app consent page (S9) comes back after sign-in;
          // every other page does not.
          navigate(
            typeof window === 'undefined'
              ? signInPathFor('')
              : signInPathFor(window.location.pathname, window.location.search),
          );
        }
      }),
    [boundary, navigate, queryClient],
  );
}

/**
 * F4 — after a refresh kept the session, re-run every read that is showing "the access token is
 * gone". TanStack treats that 401 as final (no retry, `QueryProvider`), so without this a card
 * refused while the token was expired kept "The request carries no valid session" on screen
 * until a reload, although the session was fine again a moment later.
 */
export function useRefetchAfterSessionKept(queryClient: QueryClient, api: ApiClient): void {
  useEffect(
    () =>
      api.subscribeSessionKept(() => {
        void queryClient.refetchQueries({
          predicate: (query) =>
            query.state.status === 'error' && isAccessExpired(query.state.error),
        });
      }),
    [api, queryClient],
  );
}

/** The sign-in and sign-up pages, English and Arabic (AUTHSTATE). */
const ENTRY_PAGES: ReadonlySet<string> = new Set([
  '/sign-in',
  '/ar/sign-in',
  '/sign-up',
  '/ar/sign-up',
]);

export function isEntryPage(pathname: string): boolean {
  return ENTRY_PAGES.has(pathname);
}

function currentPathname(): string {
  return typeof window === 'undefined' ? '' : window.location.pathname;
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
  useRefetchAfterSessionKept(queryClient, browserApiClient());
  return (
    <>
      {children}
      {/* R3. Warns one minute before an idle sign-out; notes real activity. */}
      <IdleSignOutWarning />
    </>
  );
}
