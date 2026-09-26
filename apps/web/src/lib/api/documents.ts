import type { ApiClient } from './client';

/**
 * DOC-01 / DOC-03 (read side) — the documents endpoints x91 delivered.
 *
 * Two reads only, both behind `doc.read`: list a project's documents
 * (`GET .../documents?projectId=`) and read one by id (`GET .../documents/:documentId`). The
 * create endpoint is `doc.write` and belongs to the editor (DOC-02), a later slice; this module
 * wraps only what the hub and the read screen consume, the same discipline the contracts gate
 * enforces on this folder.
 *
 * The list is per project by construction — the API requires a `projectId` and never lists a
 * whole tenant's documents — so the hub chooses a project before it fetches, exactly as the work
 * timeline does. "Recent across all projects" and "favorites" (the other two facets `41-…MATRIX`
 * §Docs DOC-01 names) have no endpoint and no table yet, so this slice does not pretend to them.
 *
 * DOC-02/DOC-03 (x112) appends the version half below: list a document's versions newest-first,
 * read one snapshot for compare, save a new version, and restore a prior one. The editor seeds its
 * draft from the exported `getDocument`/`DocumentView` this module already owns, so no second,
 * competing document projection is declared here.
 */

/**
 * A document as the API projects it — paired Exact with the API's `DocumentView` in the
 * contracts gate (`e2e/contracts/api-web-shapes.ts`). `organizationId` is deliberately absent:
 * the API never echoes the tenant id into a response body, and neither does this declaration.
 */
export interface DocumentView {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly body: string;
  readonly createdByUserId: string;
  /** ISO-8601 instant. */
  readonly createdAt: string;
  /** ISO-8601 instant. */
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

/** List one project's documents the caller may read. The API scopes the read to the tenant. */
export async function listDocuments(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<readonly DocumentView[]> {
  const { data } = await client.request<{ documents: readonly DocumentView[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/documents?projectId=${encodeURIComponent(projectId)}`,
  });
  return data.documents;
}

function base(organizationSlug: string, documentId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/documents/${encodeURIComponent(documentId)}`;
}

/**
 * Read one document by id.
 *
 * A document the caller may not read — a non-member of its project, or an id in another tenant —
 * is 404, not 403 (the API resolves the id tenant-scoped before the relation check), and an
 * unknown id is the same 404. The screen surfaces that as a not-found state; it never has to tell
 * the two apart, which is exactly the point of the API answering both the same way.
 */
export async function getDocument(
  client: ApiClient,
  organizationSlug: string,
  documentId: string,
): Promise<DocumentView> {
  const { data } = await client.request<DocumentView>({
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
