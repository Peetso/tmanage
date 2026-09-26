import type { ApiClient } from './client';

/**
 * DOC-04/ADM-06 (x119) — document templates.
 *
 * This module wraps the template half of the docs API: list the organization's templates, create
 * one, and apply one to a project (which creates a new document seeded from the template body). The
 * one exported response shape is {@link DocumentTemplateSummary}, paired Exact with the API's
 * `DocumentTemplateView` in the contracts gate. The applied-document shape is kept private so it
 * does not become a second, competing projection of the document record (DOC-01 owns that pairing).
 */

/**
 * One document template — paired Exact with the API's `DocumentTemplateView`. `organizationId` is
 * absent on both sides: the wire projection never echoes the tenant id.
 */
export interface DocumentTemplateSummary {
  readonly id: string;
  readonly name: string;
  readonly purpose: string;
  readonly body: string;
  readonly createdByUserId: string;
  readonly createdAt: string;
}

/** The document an apply creates. Not exported — DOC-01 owns the document-record pairing. */
interface AppliedDocument {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly body: string;
  readonly createdByUserId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The fields a create sends. Request-side, so the contracts gate does not enumerate it. */
export interface CreateDocumentTemplateInput {
  readonly name: string;
  readonly purpose: string;
  readonly body: string;
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/documents/templates`;
}

/** List the organization's document templates, name-ascending. */
export async function listDocumentTemplates(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly DocumentTemplateSummary[]> {
  const { data } = await client.request<{ templates: readonly DocumentTemplateSummary[] }>({
    path: base(organizationSlug),
  });
  return data.templates;
}

/** Create a document template. */
export async function createDocumentTemplate(
  client: ApiClient,
  organizationSlug: string,
  input: CreateDocumentTemplateInput,
): Promise<DocumentTemplateSummary> {
  const { data } = await client.request<DocumentTemplateSummary>({
    method: 'POST',
    path: base(organizationSlug),
    body: input,
  });
  return data;
}

/** Apply a template to a project — creates a new document seeded from the template body. */
export async function applyDocumentTemplate(
  client: ApiClient,
  organizationSlug: string,
  templateId: string,
  input: { projectId: string; title?: string },
): Promise<AppliedDocument> {
  const { data } = await client.request<AppliedDocument>({
    method: 'POST',
    path: `${base(organizationSlug)}/${encodeURIComponent(templateId)}/apply`,
    body: input,
  });
  return data;
}
