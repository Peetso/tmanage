import type { ApiClient } from './client';

/**
 * Document tags / labels (Docs module, x269).
 *
 * This module wraps the doc-tags API: list and define org-scoped tag definitions, and assign / list /
 * remove tags on a document. Two response shapes are exported and paired in the contracts gate —
 * {@link DocTag} (a definition, Exact with the API's `DocTagView`) and {@link DocumentTag} (a tag on a
 * document, Exact with `DocumentTagView`). `organizationId` is absent on both, as on every wire
 * projection.
 */

/** One tag definition — paired Exact with the API's `DocTagView`. */
export interface DocTag {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

/** One tag assigned to a document — paired Exact with the API's `DocumentTagView`. */
export interface DocumentTag {
  readonly id: string;
  readonly documentId: string;
  readonly tagId: string;
  readonly name: string;
  readonly createdAt: string;
}

/** The fields a define sends. Request-side (suffix `Input`), so the contracts gate ignores it. */
export interface DefineDocTagInput {
  readonly name: string;
}

function orgBase(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}`;
}

/** List the organization's tag definitions, name-ascending. */
export async function listDocTags(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly DocTag[]> {
  const { data } = await client.request<{ tags: readonly DocTag[] }>({
    path: `${orgBase(organizationSlug)}/doc-tags`,
  });
  return data.tags;
}

/** Define a tag. */
export async function defineDocTag(
  client: ApiClient,
  organizationSlug: string,
  input: DefineDocTagInput,
): Promise<DocTag> {
  const { data } = await client.request<DocTag>({
    method: 'POST',
    path: `${orgBase(organizationSlug)}/doc-tags`,
    body: input,
  });
  return data;
}

/** List the tags assigned to a document. */
export async function listDocumentTags(
  client: ApiClient,
  organizationSlug: string,
  documentId: string,
): Promise<readonly DocumentTag[]> {
  const { data } = await client.request<{ tags: readonly DocumentTag[] }>({
    path: `${orgBase(organizationSlug)}/documents/${encodeURIComponent(documentId)}/tags`,
  });
  return data.tags;
}

/** Tag a document (idempotent). */
export async function assignDocumentTag(
  client: ApiClient,
  organizationSlug: string,
  documentId: string,
  tagId: string,
): Promise<DocumentTag> {
  const { data } = await client.request<DocumentTag>({
    method: 'PUT',
    path: `${orgBase(organizationSlug)}/documents/${encodeURIComponent(documentId)}/tags/${encodeURIComponent(tagId)}`,
  });
  return data;
}

/** Untag a document. */
export async function removeDocumentTag(
  client: ApiClient,
  organizationSlug: string,
  documentId: string,
  tagId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${orgBase(organizationSlug)}/documents/${encodeURIComponent(documentId)}/tags/${encodeURIComponent(tagId)}`,
  });
}
