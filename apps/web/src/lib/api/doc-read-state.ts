import type { ApiClient } from './client';

/**
 * DOC read state (x297) — a member's private read cursor over documents. Mark a document read, mark it
 * unread, and batch-read the caller's read state for a set of documents so a "new since you last looked"
 * badge and a "mark all read" affordance can be driven client-side. All are behind the `doc.read`
 * capability the API enforces (a member marks read a document they may read); this module wraps only what
 * the read-state screen and the row badges consume, the discipline the contracts gate enforces on this
 * folder.
 */

/**
 * The caller's read state for one document — paired Exact with the API's `DocReadStateView` in the
 * contracts gate (`e2e/contracts/api-web-shapes.ts`). `organizationId`/`membershipId` are absent on both
 * sides: the wire projection never echoes the tenant id, and the membership is always the caller's own.
 */
export interface DocReadStateSummary {
  readonly docId: string;
  /** ISO-8601 instant the caller last marked this document read. */
  readonly lastReadAt: string;
}

function docBase(organizationSlug: string, documentId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/documents/${encodeURIComponent(documentId)}/read`;
}

function batchBase(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/document-read-state`;
}

/** Mark a document read for the caller now. Idempotent: a repeated call refreshes the timestamp. */
export async function markDocRead(
  client: ApiClient,
  organizationSlug: string,
  documentId: string,
): Promise<DocReadStateSummary> {
  const { data } = await client.request<DocReadStateSummary>({
    method: 'PUT',
    path: docBase(organizationSlug, documentId),
  });
  return data;
}

/** Mark a document unread for the caller. Idempotent: no read state is still success. */
export async function markDocUnread(
  client: ApiClient,
  organizationSlug: string,
  documentId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: docBase(organizationSlug, documentId),
  });
}

/**
 * The caller's read state for a batch of documents. Only documents the caller has marked read appear;
 * an empty id list returns an empty result without a request.
 */
export async function getDocReadState(
  client: ApiClient,
  organizationSlug: string,
  documentIds: readonly string[],
): Promise<readonly DocReadStateSummary[]> {
  const ids = [...new Set(documentIds.filter((id) => id !== ''))];
  if (ids.length === 0) {
    return [];
  }
  const parameters = new URLSearchParams({ docIds: ids.join(',') });
  const { data } = await client.request<{ readStates: readonly DocReadStateSummary[] }>({
    path: `${batchBase(organizationSlug)}?${parameters.toString()}`,
  });
  return data.readStates;
}
