import type { ApiClient } from './client';

/**
 * Docs "collaboration later" (x132) — the document-comments endpoints, both behind the docs caps.
 *
 * Two calls: list a document's comments (`GET .../documents/:documentId/comments`, `doc.read`) and
 * add one (`POST .../documents/:documentId/comments`, `doc.write`). A document the caller may not
 * read is 404, the same 404 an unknown or cross-tenant id answers — the API resolves the id
 * tenant-scoped before the relation check — so the panel never has to tell the cases apart.
 */

/**
 * A document comment as the API projects it — paired Exact with the API's `DocumentCommentView` in
 * the contracts gate (`e2e/contracts/api-web-shapes.ts`). `organizationId` is deliberately absent:
 * the API never echoes the tenant id into a response body, and neither does this declaration.
 */
export interface DocumentCommentView {
  readonly id: string;
  readonly documentId: string;
  readonly authorMembershipId: string;
  readonly body: string;
  /** ISO-8601 instant. */
  readonly createdAt: string;
}

function base(organizationSlug: string, documentId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/documents/${encodeURIComponent(documentId)}/comments`;
}

/** List a document's comments, oldest first. */
export async function listDocumentComments(
  client: ApiClient,
  organizationSlug: string,
  documentId: string,
): Promise<readonly DocumentCommentView[]> {
  const { data } = await client.request<{ comments: readonly DocumentCommentView[] }>({
    path: base(organizationSlug, documentId),
  });
  return data.comments;
}

/** Add a comment to a document. */
export async function addDocumentComment(
  client: ApiClient,
  organizationSlug: string,
  documentId: string,
  body: string,
): Promise<DocumentCommentView> {
  const { data } = await client.request<DocumentCommentView>({
    method: 'POST',
    path: base(organizationSlug, documentId),
    body: { body },
  });
  return data;
}
