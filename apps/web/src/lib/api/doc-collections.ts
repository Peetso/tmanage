import type { ApiClient } from './client';

/**
 * DOC collections (x264) — named document collections (lightweight wiki spaces) and their membership.
 * List the tenant's collections, create one, list a collection's member documents, and add/remove a
 * document. Reads are behind `doc.read`, writes behind `doc.write` (the API enforces both). This module
 * wraps only what the collections screen consumes, the discipline the contracts gate enforces here.
 */

/**
 * One collection — paired Exact with the API's `CollectionView` in the contracts gate
 * (`e2e/contracts/api-web-shapes.ts`). `organizationId` is absent: the wire projection never echoes the
 * tenant id.
 */
export interface DocCollectionSummary {
  readonly id: string;
  readonly name: string;
  /** ISO-8601 instant. */
  readonly createdAt: string;
}

/**
 * One document in a collection — paired Exact with the API's `CollectionDocumentView`. `id` is the
 * membership row's id; `documentId` is the document it points at.
 */
export interface CollectionDocumentSummary {
  readonly id: string;
  readonly documentId: string;
  readonly title: string;
  readonly projectId: string;
  /** ISO-8601 instant. */
  readonly createdAt: string;
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/doc-collections`;
}

function memberBase(organizationSlug: string, collectionId: string, documentId: string): string {
  return `${base(organizationSlug)}/${encodeURIComponent(collectionId)}/documents/${encodeURIComponent(documentId)}`;
}

/** List the tenant's collections, name-ascending. */
export async function listDocCollections(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly DocCollectionSummary[]> {
  const { data } = await client.request<{ collections: readonly DocCollectionSummary[] }>({
    path: base(organizationSlug),
  });
  return data.collections;
}

/** Create a collection. A duplicate name is a 409 from the API. */
export async function createDocCollection(
  client: ApiClient,
  organizationSlug: string,
  name: string,
): Promise<DocCollectionSummary> {
  const { data } = await client.request<DocCollectionSummary>({
    method: 'POST',
    path: base(organizationSlug),
    body: { name },
  });
  return data;
}

/** List one collection's member documents, projected to documents the caller can still read. */
export async function listCollectionDocuments(
  client: ApiClient,
  organizationSlug: string,
  collectionId: string,
): Promise<readonly CollectionDocumentSummary[]> {
  const { data } = await client.request<{ documents: readonly CollectionDocumentSummary[] }>({
    path: `${base(organizationSlug)}/${encodeURIComponent(collectionId)}`,
  });
  return data.documents;
}

/** Add a document to a collection. Idempotent: a repeated call returns the same summary. */
export async function addDocumentToCollection(
  client: ApiClient,
  organizationSlug: string,
  collectionId: string,
  documentId: string,
): Promise<CollectionDocumentSummary> {
  const { data } = await client.request<CollectionDocumentSummary>({
    method: 'PUT',
    path: memberBase(organizationSlug, collectionId, documentId),
  });
  return data;
}

/** Remove a document from a collection. Idempotent: no membership is still success. */
export async function removeDocumentFromCollection(
  client: ApiClient,
  organizationSlug: string,
  collectionId: string,
  documentId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: memberBase(organizationSlug, collectionId, documentId),
  });
}
