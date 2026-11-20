'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { browserApiClient, browserMayHaveSession } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { authBoundary, type AuthBoundary } from '../../lib/auth-boundary';
import { workspaceDestination } from '../../lib/signed-in-destination';
import { SessionStatusCard, SignedInCard } from './SessionCards';
import { useSessionCheck } from './useSessionCheck';

/**
 * AUTHSTATE — the entry pages (`/sign-in`, `/ar/sign-in`, `/sign-up`, `/ar/sign-up`) ask the
 * shared session check before they show a form.
 *
 * - **Signed in** → "You're signed in as <email>", with Continue (an allowed `?next=`, else their
 *   workspace) and Sign out. Never the empty form.
 * - **Signed out** → the page's own form (`children`).
 * - **Unreachable** → "Can't reach TManage — retrying". A restart is not a sign-out.
 *
 * `sessionHint` is the server's reading of the readable CSRF cookie: with it the first HTML is
 * "Checking your sign-in…" rather than a form that might belong to nobody; without it the form
 * is drawn at once (and the check answers "signed out" without a request).
 *
 * A second-factor return (`?google=mfa`, `?microsoft=mfa`, `?sso=mfa`) has no session yet and
 * goes straight to the form, which finishes it.
 */
export interface EntrySessionGateProps {
  readonly sessionHint: boolean;
  readonly children: ReactNode;
  /** Injected in tests. */
  readonly client?: ApiClient;
  readonly boundary?: AuthBoundary;
  readonly mayHaveSession?: () => boolean;
  readonly navigate?: (path: string) => void;
  /** The query string (`location.search`); injected in tests. */
  readonly search?: () => string;
}

const SECOND_STEP_RETURNS = ['google', 'microsoft', 'sso'] as const;

function currentSearch(): string {
  return typeof window === 'undefined' ? '' : window.location.search;
}

export function isSecondStepReturn(search: string): boolean {
  const params = new URLSearchParams(search);
  return SECOND_STEP_RETURNS.some((name) => params.get(name) === 'mfa');
}

export function EntrySessionGate({
  sessionHint,
  children,
  client,
  boundary = authBoundary,
  mayHaveSession = browserMayHaveSession,
  navigate,
  search = currentSearch,
}: EntrySessionGateProps) {
  const router = useRouter();
  const api = client ?? browserApiClient();
  const go = navigate ?? ((path: string) => router.replace(path));
  // Read after hydration: the server render has no `location`, and must match the first client one.
  const [secondStep, setSecondStep] = useState(false);
  useEffect(() => setSecondStep(isSecondStepReturn(search())), [search]);

  const { view, retryNow } = useSessionCheck({
    client: api,
    mayHaveSession,
    enabled: sessionHint && !secondStep,
    boundary,
  });
  const [signedOutHere, setSignedOutHere] = useState(false);
  const [destination, setDestination] = useState<string | undefined>(undefined);

  const signedIn = view.state === 'signed-in' && !signedOutHere;
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    void workspaceDestination(api, new URLSearchParams(search()).get('next')).then((path) => {
      if (live) setDestination(path);
    });
    return () => {
      live = false;
    };
  }, [api, search, signedIn]);

  if (!sessionHint || secondStep || signedOutHere || view.state === 'signed-out') return children;
  if (view.state === 'signed-in') {
    return (
      <SignedInCard
        account={view.account}
        destination={destination}
        client={api}
        boundary={boundary}
        onContinue={go}
        onSignedOut={() => setSignedOutHere(true)}
      />
    );
  }
  return <SessionStatusCard state={view.state} onRetry={retryNow} />;
}
