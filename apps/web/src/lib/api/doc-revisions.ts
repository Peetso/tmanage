import type { ApiClient } from './client';

/**
 * DOC revision history (x241) — a document's snapshot trail. Capture a revision, list the trail
 * newest-first, and restore a prior revision. All three are behind the docs capabilities the API
 * enforces (`doc.read` for the list, `doc.write` for capture/restore); this module wraps only what
 * the history panel consumes, the discipline the contracts gate enforces on this folder.
 */

/**
 * One revision of a document — paired Exact with the API's `DocRevisionView` in the contracts gate
 * (`e2e/contracts/api-web-shapes.ts`). `organizationId` is absent on both sides: the wire projection
 * never echoes the tenant id.
 */
export interface DocRevisionSummary {
  readonly id: string;
  readonly docId: string;
  readonly revNo: number;
  readonly bodySnapshot: string;
  readonly savedBy: string;
  /** ISO-8601 instant. */
  readonly savedAt: string;
}

function base(organizationSlug: string, documentId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/documents/${encodeURIComponent(documentId)}/revisions`;
}

/** List a document's revisions, newest first. */
export async function listDocRevisions(
  client: ApiClient,
  organizationSlug: string,
  documentId: string,
): Promise<readonly DocRevisionSummary[]> {
  const { data } = await client.request<{ revisions: readonly DocRevisionSummary[] }>({
    path: base(organizationSlug, documentId),
  });
  return data.revisions;
}

/** Capture a revision: append an immutable snapshot and bump the current body. */
export async function captureDocRevision(
  client: ApiClient,
  organizationSlug: string,
  documentId: string,
  bodySnapshot: string,
): Promise<DocRevisionSummary> {
  const { data } = await client.request<DocRevisionSummary>({
    method: 'POST',
    path: base(organizationSlug, documentId),
    body: { bodySnapshot },
  });
  return data;
}

/** Restore a prior revision: write a NEW revision equal to it (forward-append, history is intact). */
export async function restoreDocRevision(
  client: ApiClient,
  organizationSlug: string,
  documentId: string,
  revisionId: string,
): Promise<DocRevisionSummary> {
  const { data } = await client.request<DocRevisionSummary>({
    method: 'POST',
    path: `${base(organizationSlug, documentId)}/${encodeURIComponent(revisionId)}/restore`,
  });
  return data;
}
