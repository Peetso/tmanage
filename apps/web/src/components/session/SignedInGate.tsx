'use client';

import { useEffect, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { browserApiClient, browserMayHaveSession } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import type { AuthBoundary } from '../../lib/auth-boundary';
import { signInPathFor } from '../../lib/sign-in-return';
import { workspaceGate } from '../../lib/workspace-gate';
import { SessionStatusCard } from './SessionCards';
import { useSessionCheck } from './useSessionCheck';

/**
 * AUTHSTATE — every signed-in area (each workspace `/{slug}/…`, Platform admin, the picker, the
 * device list) renders its children only once the shared session check (`lib/session-check.ts`)
 * has confirmed a session. Until then the identity card says "Checking your sign-in…"; nothing of
 * the area's chrome — no rail, no menu, no skeleton of a workspace — is drawn.
 *
 * - **Signed out** → replaced by `signedOutLocation` (sign-in, keeping an allowed return path).
 * - **Unreachable** → "Can't reach TManage — retrying", and the check runs again. Never sign-in.
 *
 * The server already redirects a request with no session cookie at all (`proxy.ts`,
 * `workspace-gate.ts`, `apps/server/platform-gate.mjs`); this is the half that also catches a
 * cookie whose session has ended, and the half that refreshes an expired access cookie.
 * Membership itself stays the API's answer on every read.
 */
export interface SignedInGateProps {
  readonly children: ReactNode;
  /**
   * The workspace this gate guards (`[orgSlug]`), or absent for the other signed-in areas. A
   * workspace answers a signed-out visitor exactly as its server gate does (`workspaceGate`):
   * the portal goes to the portal's sign-in, which itself stays open.
   */
  readonly workspaceSlug?: string;
  /** Injected in tests. */
  readonly client?: ApiClient;
  readonly boundary?: AuthBoundary;
  readonly mayHaveSession?: () => boolean;
  readonly navigate?: (path: string) => void;
}

/** Where a signed-out visitor to `pathname` goes, or `null` when the page is open to them. */
export function signedOutLocation(
  pathname: string,
  search: string,
  workspaceSlug?: string,
): string | null {
  if (workspaceSlug === undefined) return signInPathFor(pathname, search);
  const gate = workspaceGate({ slug: workspaceSlug, pathname, hasSession: false });
  if (gate.kind === 'open') return null;
  return gate.kind === 'sign-in' ? gate.location : signInPathFor(pathname, search);
}

export function SignedInGate({
  children,
  workspaceSlug,
  client,
  boundary,
  mayHaveSession = browserMayHaveSession,
  navigate,
}: SignedInGateProps) {
  const router = useRouter();
  const pathname = usePathname() ?? '';
  const open = signedOutLocation(pathname, '', workspaceSlug) === null;
  const { view, retryNow } = useSessionCheck({
    client: client ?? browserApiClient(),
    mayHaveSession,
    enabled: !open,
    ...(boundary ? { boundary } : {}),
  });

  const signedOut = !open && view.state === 'signed-out';
  useEffect(() => {
    if (!signedOut) return;
    const search = typeof window === 'undefined' ? '' : window.location.search;
    const target = signedOutLocation(pathname, search, workspaceSlug) ?? signInPathFor(pathname);
    if (navigate) navigate(target);
    else router.replace(target);
  }, [navigate, pathname, router, signedOut, workspaceSlug]);

  if (open || view.state === 'signed-in') return children;
  return (
    <SessionStatusCard
      state={view.state === 'unknown' ? 'unknown' : 'checking'}
      onRetry={retryNow}
    />
  );
}
