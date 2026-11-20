'use client';

import { useContext } from 'react';
import { QueryClient, QueryClientContext, useQuery } from '@tanstack/react-query';
import { browserApiClient } from './api/browser-client';
import { ApiRequestError } from './api/errors';
import { listOrganizations, type OrganizationSummary } from './api/organizations';

/**
 * Staff preview of the client portal (2026-10-31 live-test fix).
 *
 * A staff member who opens `/:org/portal` sees the portal as a client would — but the client-only
 * reads (`GET portal/requests`, `GET portal/projects/:id/files`) and the one client write
 * (`POST portal/requests`) refuse anybody who is not a client principal, and the live test saw
 * those refusals as red "You do not have permission" banners. The API is right to refuse; the
 * portal should not have asked. These helpers tell the two audiences apart from the session's own
 * organization list (`audience`, the read the shells already make under the same query key) so
 * the preview shows the client's empty states and the designed preview notices instead
 * (Figma "Portal · Staff preview, no agreed date" 446:37676 and "Portal · Staff preview, new
 * request" 446:37829).
 *
 * Never used to authorize anything — the API decides every action.
 */

const SHELL_ORGANIZATIONS_KEY = ['shell', 'organizations'] as const;
const IDLE_QUERY_CLIENT = new QueryClient();

function previewFrom(
  list: readonly OrganizationSummary[] | undefined,
  organizationSlug: string,
): boolean | undefined {
  if (!Array.isArray(list)) return undefined;
  const row = list.find((organization) => organization.slug === organizationSlug);
  if (!row) return undefined;
  return row.audience !== 'client';
}

/** True when the signed-in person is staff of this organization looking at its portal. */
export function usePortalPreview(organizationSlug: string): boolean {
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
  return previewFrom(organizations.data, organizationSlug) === true;
}

/**
 * Runs a client-only portal read, answering `empty` for a staff preview instead of letting the
 * API's 403 reach the screen. A 403 for anybody else is rethrown untouched.
 *
 * `refusals` names the statuses the read answers a non-client with: 403 by default; the journey
 * read answers 404 (`portal_journey_not_visible`, it hides the project from anybody who is not
 * one of its clients), so it passes `[403, 404]` (QA-FIX-O L10).
 */
export async function clientOnlyRead<T>(
  queryClient: QueryClient,
  organizationSlug: string,
  empty: T,
  load: () => Promise<T>,
  refusals: readonly number[] = [403],
): Promise<T> {
  const known = previewFrom(
    queryClient.getQueryData<readonly OrganizationSummary[]>(SHELL_ORGANIZATIONS_KEY),
    organizationSlug,
  );
  if (known === true) return empty;
  try {
    return await load();
  } catch (error) {
    if (
      !(error instanceof ApiRequestError) ||
      !refusals.includes(error.status) ||
      known === false
    ) {
      throw error;
    }
    let list: readonly OrganizationSummary[] | undefined;
    try {
      list = await queryClient.ensureQueryData({
        queryKey: SHELL_ORGANIZATIONS_KEY,
        queryFn: () => listOrganizations(browserApiClient()),
      });
    } catch {
      throw error;
    }
    if (previewFrom(list, organizationSlug) === true) return empty;
    throw error;
  }
}
