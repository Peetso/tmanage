import type { ApiClient } from './client';

/**
 * DOC bookmarks / favorites (x242) — a member's private favorites over documents. Read the caller's
 * bookmark status of one document, bookmark/unbookmark it, and list the caller's bookmarks. All are
 * behind the `doc.read` capability the API enforces (a member bookmarks a document they may read); this
 * module wraps only what the bookmark toggle and the favorites screen consume, the discipline the
 * contracts gate enforces on this folder.
 */

/**
 * One of the caller's bookmarked documents — paired Exact with the API's `DocBookmarkView` in the
 * contracts gate (`e2e/contracts/api-web-shapes.ts`). `organizationId`/`membershipId` are absent on both
 * sides: the wire projection never echoes the tenant id, and the membership is always the caller's own.
 */
export interface DocBookmarkSummary {
  readonly id: string;
  readonly docId: string;
  readonly title: string;
  readonly projectId: string;
  /** ISO-8601 instant. */
  readonly createdAt: string;
}

function docBase(organizationSlug: string, documentId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/documents/${encodeURIComponent(documentId)}/bookmark`;
}

function listBase(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/document-bookmarks`;
}

/** Whether the caller has bookmarked a document. */
export async function getDocBookmarkStatus(
  client: ApiClient,
  organizationSlug: string,
  documentId: string,
): Promise<boolean> {
  const { data } = await client.request<{ bookmarked: boolean }>({
    path: docBase(organizationSlug, documentId),
  });
  return data.bookmarked;
}

/** Bookmark a document for the caller. Idempotent: a repeated call returns the same summary. */
export async function addDocBookmark(
  client: ApiClient,
  organizationSlug: string,
  documentId: string,
): Promise<DocBookmarkSummary> {
  const { data } = await client.request<DocBookmarkSummary>({
    method: 'PUT',
    path: docBase(organizationSlug, documentId),
  });
  return data;
}

/** Unbookmark a document for the caller. Idempotent: no bookmark is still success. */
export async function removeDocBookmark(
  client: ApiClient,
  organizationSlug: string,
  documentId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: docBase(organizationSlug, documentId),
  });
}

/** List the caller's bookmarks, newest first. */
export async function listDocBookmarks(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly DocBookmarkSummary[]> {
  const { data } = await client.request<{ bookmarks: readonly DocBookmarkSummary[] }>({
    path: listBase(organizationSlug),
  });
  return data.bookmarks;
}
