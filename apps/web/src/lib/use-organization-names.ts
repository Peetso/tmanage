'use client';

import { useContext } from 'react';
import { QueryClient, QueryClientContext, useQuery } from '@tanstack/react-query';
import { browserApiClient } from './api/browser-client';
import { listOrganizations, type OrganizationSummary } from './api/organizations';
import { FIXTURE_CLIENT_NAME, FIXTURE_ORGANIZATION_NAME } from './fixtures';

/**
 * The real names behind the shells' headers.
 *
 * Every internal page still hands its shell `FIXTURE_ORGANIZATION_NAME` ("Northstar Studio", the
 * design export's demo company), and every portal page `FIXTURE_CLIENT_NAME`. A signed-in person
 * must never see either: they are the design's sample data, not theirs. The session's own
 * organization list (`GET /v1/organizations`, the read `ID-04` and the Control Center orb already
 * make, under the same query key so it is one request) carries both names, so the shells resolve
 * them here instead of trusting the prop.
 *
 * The organization's own row wins whenever the list has it. While the list is still being read a
 * fixture name is held back (the header shows nothing rather than the sample company); a name a
 * caller passed that is not a fixture is shown as given.
 */

const SHELL_ORGANIZATIONS_KEY = ['shell', 'organizations'] as const;

/** Stands in when no `QueryClientProvider` is mounted, so the hook never throws; never fetches. */
const IDLE_QUERY_CLIENT = new QueryClient();

function useOrganizationSummary(organizationSlug: string): {
  readonly summary: OrganizationSummary | undefined;
  /** True while the list is still being read, so a sample name must not stand in yet. */
  readonly pending: boolean;
} {
  const contextClient = useContext(QueryClientContext);
  const organizations = useQuery(
    {
      queryKey: SHELL_ORGANIZATIONS_KEY,
      queryFn: () => listOrganizations(browserApiClient()),
      staleTime: 5 * 60_000,
      enabled: contextClient !== undefined,
    },
    contextClient ?? IDLE_QUERY_CLIENT,
  );
  return {
    summary: organizations.data?.find((org) => org.slug === organizationSlug),
    pending: contextClient !== undefined && organizations.isPending,
  };
}

function resolve(
  real: string | null | undefined,
  passed: string,
  fixture: string,
  pending: boolean,
): string {
  if (real) return real;
  if (pending && passed === fixture) return '';
  return passed;
}

/** The organization's own name for the internal shell and screens that print it. */
export function useOrganizationName(organizationSlug: string, passedName: string): string {
  const { summary, pending } = useOrganizationSummary(organizationSlug);
  return resolve(summary?.name, passedName, FIXTURE_ORGANIZATION_NAME, pending);
}

/**
 * The portal's two names: the client reading it and the organization delivering to them.
 *
 * An internal person previewing the portal has no client membership, so the client stays generic
 * ("Your client") rather than borrowing the design's sample company.
 */
export function usePortalNames(
  organizationSlug: string,
  passedClientName: string,
  passedProviderName: string,
): { readonly clientName: string; readonly providerName: string } {
  const { summary, pending } = useOrganizationSummary(organizationSlug);
  const clientName = resolve(
    summary?.clientOrganizationName,
    passedClientName,
    FIXTURE_CLIENT_NAME,
    pending,
  );
  return {
    // An internal person previewing the portal: their row has no client name to show.
    clientName:
      summary && !summary.clientOrganizationName && passedClientName === FIXTURE_CLIENT_NAME
        ? 'Your client'
        : clientName,
    providerName: resolve(summary?.name, passedProviderName, FIXTURE_ORGANIZATION_NAME, pending),
  };
}

/**
 * The caller's role in this organization, from the same session read (CQ-06).
 *
 * `known` is false while the list is being read, and also when no `QueryClientProvider` is mounted
 * (a story or a bare render), so a caller can tell "not yet" from "this role". Never used to
 * authorize anything — the API decides every action — only to stop offering pages that would
 * refuse the person.
 */
export function useOrganizationRole(organizationSlug: string): {
  readonly role: string | undefined;
  readonly known: boolean;
  /** True when no `QueryClientProvider` is mounted, so the role can never be read here. */
  readonly unavailable: boolean;
} {
  const contextClient = useContext(QueryClientContext);
  const { summary, pending } = useOrganizationSummary(organizationSlug);
  const unavailable = contextClient === undefined;
  return { role: summary?.role, known: !unavailable && !pending, unavailable };
}
