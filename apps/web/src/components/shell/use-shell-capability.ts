'use client';

import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Capability } from '@tmanage/domain';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { listOrganizations } from '../../lib/api/organizations';
import { roleMayUse } from '../../lib/role-capability';

/**
 * May the signed-in person's role use a capability in this organization — for drawing a menu row?
 *
 * Reads the session's organization list under the key the rail's Control Center orb already uses
 * (`['shell', 'organizations']`), so the shell makes one read for both. Fails closed: until the
 * role is known every gated row answers no. Never an authorization; the API decides each request.
 */
export function useShellCapability(
  organizationSlug: string,
  client?: ApiClient,
): (capability: Capability) => boolean {
  const organizations = useQuery({
    queryKey: ['shell', 'organizations'],
    queryFn: () => listOrganizations(client ?? browserApiClient()),
    staleTime: 5 * 60_000,
  });
  const membership = organizations.data?.find((org) => org.slug === organizationSlug);
  const role = membership?.role;
  const capabilities = membership?.capabilities;
  return useCallback(
    (capability: Capability) => roleMayUse(role, capabilities, capability),
    [role, capabilities],
  );
}
