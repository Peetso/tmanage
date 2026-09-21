import type { ApiClient } from './client';

/**
 * DOC-02/DOC-03 (x112) — the document editor and its version history.
 *
 * This module wraps the version half of the docs API: read the current document, list its versions
 * newest-first, read one snapshot for compare, save a new version, and restore a prior one. The
 * document *record* shape (`DocumentRecord`) is deliberately **not** exported: DOC-01's hub/read
 * screen (x106) owns the exported, contract-paired `DocumentView`↔web pairing, so this file keeps
 * its own read of the document private to avoid a second, competing exported projection. The one
 * shape this slice owns and pairs is {@link DocumentVersionSummary}.
 */

/**
 * The current document, as the editor reads it to seed the draft. Not exported — see the module
 * note. The fields mirror the API's `DocumentView`, but only what the editor renders is read.
 */
interface DocumentRecord {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly body: string;
  readonly createdByUserId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * One version of a document — paired Exact with the API's `DocumentVersionView` in the contracts
 * gate. `organizationId` is absent on both sides: the wire projection never echoes the tenant id.
 */
export interface DocumentVersionSummary {
  readonly id: string;
  readonly documentId: string;
  readonly versionNo: number;
  readonly body: string;
  readonly editedByUserId: string;
  readonly createdAt: string;
}

function base(organizationSlug: string, documentId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/documents/${encodeURIComponent(documentId)}`;
}

/** Read the current document — its title and current body seed the editor. */
export async function getDocument(
  client: ApiClient,
  organizationSlug: string,
  documentId: string,
): Promise<DocumentRecord> {
  const { data } = await client.request<DocumentRecord>({
    path: base(organizationSlug, documentId),
  });
  return data;
}

/** List a document's versions, newest first. */
export async function listDocumentVersions(
  client: ApiClient,
  organizationSlug: string,
  documentId: string,
): Promise<readonly DocumentVersionSummary[]> {
  const { data } = await client.request<{ versions: readonly DocumentVersionSummary[] }>({
    path: `${base(organizationSlug, documentId)}/versions`,
  });
  return data.versions;
}

/** Read one snapshot of a document by its version number, for compare. */
export async function getDocumentVersion(
  client: ApiClient,
  organizationSlug: string,
  documentId: string,
  versionNo: number,
): Promise<DocumentVersionSummary> {
  const { data } = await client.request<DocumentVersionSummary>({
    path: `${base(organizationSlug, documentId)}/versions/${encodeURIComponent(String(versionNo))}`,
  });
  return data;
}

/** Save a new version: append an immutable snapshot and bump the current body. */
export async function saveDocumentVersion(
  client: ApiClient,
  organizationSlug: string,
  documentId: string,
  body: string,
): Promise<DocumentVersionSummary> {
  const { data } = await client.request<DocumentVersionSummary>({
    method: 'POST',
    path: `${base(organizationSlug, documentId)}/versions`,
    body: { body },
  });
  return data;
}

/** Restore a prior version: write a NEW version equal to it (forward-append, history is intact). */
export async function restoreDocumentVersion(
  client: ApiClient,
  organizationSlug: string,
  documentId: string,
  versionNo: number,
): Promise<DocumentVersionSummary> {
  const { data } = await client.request<DocumentVersionSummary>({
    method: 'POST',
    path: `${base(organizationSlug, documentId)}/restore`,
    body: { versionNo },
  });
  return data;
}
