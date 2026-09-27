import type { ApiClient } from './client';

/**
 * DOC links + backlinks (x296) — author-created relations between documents. Read a document's outgoing
 * links and its read-only "linked from" backlinks (both `doc.read`), add a link and remove one (both
 * `doc.write`). This module wraps only what the links and backlinks panels consume, the discipline the
 * contracts gate enforces on this folder.
 */

/**
 * One linked document — paired Exact with the API's `DocLinkView` in the contracts gate
 * (`e2e/contracts/api-web-shapes.ts`). For an outgoing link `docId` is the target; for a backlink it is
 * the source. `organizationId`/the author are absent on both sides: the wire projection never echoes
 * the tenant id nor the author.
 */
export interface DocLinkSummary {
  readonly id: string;
  readonly docId: string;
  readonly title: string;
  readonly projectId: string;
  /** ISO-8601 instant. */
  readonly createdAt: string;
}

function linksBase(organizationSlug: string, documentId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/documents/${encodeURIComponent(documentId)}/links`;
}

function backlinksBase(organizationSlug: string, documentId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/documents/${encodeURIComponent(documentId)}/backlinks`;
}

/** List a document's outgoing links, newest first. */
export async function listDocLinks(
  client: ApiClient,
  organizationSlug: string,
  documentId: string,
): Promise<readonly DocLinkSummary[]> {
  const { data } = await client.request<{ links: readonly DocLinkSummary[] }>({
    path: linksBase(organizationSlug, documentId),
  });
  return data.links;
}

/** List the documents that link to a document (backlinks / "linked from"), newest first. */
export async function listDocBacklinks(
  client: ApiClient,
  organizationSlug: string,
  documentId: string,
): Promise<readonly DocLinkSummary[]> {
  const { data } = await client.request<{ backlinks: readonly DocLinkSummary[] }>({
    path: backlinksBase(organizationSlug, documentId),
  });
  return data.backlinks;
}

/** Link a document to another. Idempotent: a repeated call returns the same summary. */
export async function addDocLink(
  client: ApiClient,
  organizationSlug: string,
  documentId: string,
  targetDocId: string,
): Promise<DocLinkSummary> {
  const { data } = await client.request<DocLinkSummary>({
    method: 'POST',
    path: linksBase(organizationSlug, documentId),
    body: { targetDocId },
  });
  return data;
}

/** Remove a link from a document to another. Idempotent: no link is still success. */
export async function removeDocLink(
  client: ApiClient,
  organizationSlug: string,
  documentId: string,
  targetDocId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${linksBase(organizationSlug, documentId)}/${encodeURIComponent(targetDocId)}`,
  });
}
