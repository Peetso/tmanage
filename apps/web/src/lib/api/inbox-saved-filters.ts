import type { ApiClient } from './client';

/**
 * INBOX saved filters (IN-02 "All inbox", x261) — a member's private, named inbox filter sets. List
 * the caller's saved filters, save the current filter under a name, and delete one. All are behind
 * the `work.read` capability the API enforces on the inbox; this module wraps only what the saved-
 * filter chips and the save-current-filter dialog consume, the discipline the contracts gate enforces
 * on this folder.
 */

/**
 * One of the caller's saved inbox filters — paired Exact with the API's `InboxSavedFilterView` in the
 * contracts gate (`e2e/contracts/api-web-shapes.ts`). `organizationId`/`membershipId` are absent on
 * both sides: the wire projection never echoes the tenant id, and the membership is always the
 * caller's own. `filter` is the opaque, serialized facet set the client saved.
 */
export interface InboxSavedFilterView {
  readonly id: string;
  readonly name: string;
  readonly filter: string;
  /** ISO-8601 instant. */
  readonly createdAt: string;
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/inbox/saved-filters`;
}

/** List the caller's saved inbox filters, newest first. */
export async function listInboxSavedFilters(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly InboxSavedFilterView[]> {
  const { data } = await client.request<{ savedFilters: readonly InboxSavedFilterView[] }>({
    path: base(organizationSlug),
  });
  return data.savedFilters;
}

/** Save the current inbox filter under a name for the caller. A duplicate name is rejected (409). */
export async function createInboxSavedFilter(
  client: ApiClient,
  organizationSlug: string,
  input: { readonly name: string; readonly filter: string },
): Promise<InboxSavedFilterView> {
  const { data } = await client.request<InboxSavedFilterView>({
    method: 'POST',
    path: base(organizationSlug),
    body: input,
  });
  return data;
}

/** Delete one of the caller's saved inbox filters by id. Returns the remaining list. */
export async function deleteInboxSavedFilter(
  client: ApiClient,
  organizationSlug: string,
  savedFilterId: string,
): Promise<readonly InboxSavedFilterView[]> {
  const { data } = await client.request<{ savedFilters: readonly InboxSavedFilterView[] }>({
    method: 'DELETE',
    path: `${base(organizationSlug)}/${encodeURIComponent(savedFilterId)}`,
  });
  return data.savedFilters;
}
