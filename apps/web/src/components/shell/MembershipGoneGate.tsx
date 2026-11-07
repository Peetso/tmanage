'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, InlineAlert } from '@tmanage/ui';
import { IdentityShell } from './IdentityShell';
import { rememberOrganizations, wasKnownOrganization } from './known-memberships';
import { NotFoundState, StateScreen } from '../state/StateScreens';
import { browserApiClient } from '../../lib/api/browser-client';
import { listOrganizations } from '../../lib/api/organizations';
import { signOut } from '../../lib/api/session';
import { authBoundary } from '../../lib/auth-boundary';

/**
 * A person whose membership was removed — offboarded, or their last role revoked — can still hold
 * a valid session cookie and an old URL into the organization (ACC-14). The API refuses every
 * request into an organization they no longer belong to, and the organization simply drops out of
 * the session's own list (`GET /v1/organizations`, the query the rail's Control orb shares). Left
 * alone the shell would head itself with the design's sample company ("Northstar Studio") and fill
 * with raw load failures. This reads that same list and, once it has loaded, shows one
 * "no longer have access" page instead of the app when the organization the URL names is absent.
 *
 * It decides only on a successful read: a still-loading or failed list is not "access removed", so
 * the app renders normally and its own error handling takes over. Mount it only where a
 * `QueryClient` is in the tree.
 *
 * An absent slug is "removed" only when this browser saw it in an earlier list (B16,
 * `known-memberships`). A slug it never saw — `/admin` read as a workspace, a typo, someone else's
 * organization — shows the not-found state instead, so a stranger is not told they "no longer"
 * have access to something they never had, and the page does not confirm that the slug exists.
 */
export function MembershipGoneGate({
  organizationSlug,
  children,
}: {
  organizationSlug: string;
  children: ReactNode;
}) {
  const organizations = useQuery({
    queryKey: ['shell', 'organizations'],
    queryFn: () => listOrganizations(browserApiClient()),
    staleTime: 5 * 60_000,
  });
  const loaded = organizations.isSuccess ? organizations.data : null;

  useEffect(() => {
    if (loaded) rememberOrganizations(loaded.map((org) => org.slug));
  }, [loaded]);

  // Only a loaded list can tell "removed" from "not read yet". Until then, render the app.
  if (!loaded) return <>{children}</>;
  if (loaded.some((org) => org.slug === organizationSlug)) return <>{children}</>;
  if (!wasKnownOrganization(organizationSlug)) {
    return (
      <StateScreen label="Not found" labelKey="StateScreens.eyebrowNotFound">
        <NotFoundState homeHref="/organizations" />
      </StateScreen>
    );
  }

  return <MembershipGonePage />;
}

/**
 * The "no longer have access" page itself.
 *
 * It is a separate component, not inline in the gate, so its `useRouter` and sign-out mutation run
 * only when this page actually renders. The gate mounts wherever `AppShell` does — including the
 * common case where it passes straight through to the app — and those pass-through renders must not
 * depend on a Next router being in the tree (a bare render in a test or story has none).
 */
function MembershipGonePage() {
  const router = useRouter();
  const endSession = useMutation({
    mutationFn: () => signOut(browserApiClient()),
    onSuccess: () => {
      // Clear every cached query in every tab before navigating, exactly as the sessions screen
      // does (review finding D01): the root QueryClient outlives a client-side navigation.
      authBoundary.announce('signed-out');
      router.push('/sign-in');
    },
  });

  return (
    <IdentityShell screenId="SYS" eyebrow="No access">
      <h1 className="tm-identity__title">You no longer have access</h1>
      <InlineAlert tone="warning" title="Your access to this workspace was removed">
        An administrator removed your membership, so this workspace is no longer open to you. If you
        think this is a mistake, contact them to be invited again.
      </InlineAlert>
      <div className="tm-stack tm-stack--tight">
        <Button
          tone="destructive"
          size="accessible"
          loading={endSession.isPending}
          loadingLabel="Signing out"
          onClick={() => endSession.mutate()}
        >
          Sign out
        </Button>
        {endSession.isError ? (
          <InlineAlert tone="danger" title="Sign-out failed" live>
            Try again in a moment.
          </InlineAlert>
        ) : null}
      </div>
      <p>
        <Link href="/organizations">Your other organizations</Link>
      </p>
    </IdentityShell>
  );
}
