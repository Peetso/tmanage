'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert } from '@tmanage/ui';
import { IdentityShell } from '../shell/IdentityShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listOrganizations } from '../../lib/api/organizations';

/**
 * A suspended company's members see one page: "This workspace is suspended — contact support".
 * The API already refuses every request into a suspended organization (403); this reads the
 * session's own organization list (the query the rail's Control orb shares) so the person sees
 * the reason instead of a page of failed loads. Their data is kept; nothing here deletes.
 * Mount it only where a `QueryClient` is in the tree.
 */
export function WorkspaceSuspendedGate({
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
  const current = organizations.data?.find((org) => org.slug === organizationSlug);
  if (!current?.suspended) return <>{children}</>;
  return (
    <IdentityShell screenId="SYS" eyebrow="Workspace suspended">
      <h1 className="tm-identity__title">{current.name} is suspended</h1>
      <InlineAlert tone="warning" title="This workspace is suspended">
        <Link href="/contact">Contact support</Link> to have it reopened. Nothing has been deleted.
      </InlineAlert>
      <p>
        <Link href="/organizations">Your other organizations</Link>
      </p>
    </IdentityShell>
  );
}
