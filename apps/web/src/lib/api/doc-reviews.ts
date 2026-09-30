import type { ApiClient } from './client';

/**
 * Docs review workflow (x313) — the document-review endpoints, all behind the docs caps.
 *
 * Three calls: list a document's reviews (`GET .../documents/:documentId/reviews`, `doc.read`),
 * request one (`POST`, `doc.write`) and decide one (`PUT .../reviews/:reviewId`, `doc.write`). A
 * document the caller may not read is 404, the same 404 an unknown or cross-tenant id answers — the
 * API resolves the id tenant-scoped before the relation check — so the view never tells the cases
 * apart. A caller who may read but not write the document is 403, and a re-decide of a decided review
 * is 409.
 */

/** A review's state: requested, then approved or sent back for changes. */
export type DocReviewState = 'pending' | 'approved' | 'changes_requested';

/**
 * A document review as the API projects it — paired Exact with the API's `DocReviewView` in the
 * contracts gate (`e2e/contracts/api-web-shapes.ts`). `organizationId` is deliberately absent: the
 * API never echoes the tenant id into a response body, and neither does this declaration.
 */
export interface DocReviewView {
  readonly id: string;
  readonly documentId: string;
  readonly requestedBy: string;
  readonly reviewerUserId: string;
  readonly state: DocReviewState;
  readonly note: string | null;
  /** ISO-8601 instant. */
  readonly createdAt: string;
  /** ISO-8601 instant, or null while pending. */
  readonly decidedAt: string | null;
}

function base(organizationSlug: string, documentId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/documents/${encodeURIComponent(documentId)}/reviews`;
}

/** List a document's reviews, oldest first. */
export async function listDocReviews(
  client: ApiClient,
  organizationSlug: string,
  documentId: string,
): Promise<readonly DocReviewView[]> {
  const { data } = await client.request<{ reviews: readonly DocReviewView[] }>({
    path: base(organizationSlug, documentId),
  });
  return data.reviews;
}

/** Request a review of a document from a reviewer. */
export async function requestDocReview(
  client: ApiClient,
  organizationSlug: string,
  documentId: string,
  input: { reviewerUserId: string; note?: string },
): Promise<DocReviewView> {
  const { data } = await client.request<DocReviewView>({
    method: 'POST',
    path: base(organizationSlug, documentId),
    body: { reviewerUserId: input.reviewerUserId, ...(input.note ? { note: input.note } : {}) },
  });
  return data;
}

/** Decide a review — approve or request changes (a note is required when requesting changes). */
export async function decideDocReview(
  client: ApiClient,
  organizationSlug: string,
  documentId: string,
  reviewId: string,
  input: { state: 'approved' | 'changes_requested'; note?: string },
): Promise<DocReviewView> {
  const { data } = await client.request<DocReviewView>({
    method: 'PUT',
    path: `${base(organizationSlug, documentId)}/${encodeURIComponent(reviewId)}`,
    body: { state: input.state, ...(input.note ? { note: input.note } : {}) },
  });
  return data;
}
