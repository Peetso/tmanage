import type { ApiClient } from './client';

/**
 * DOC-04 (x130) — document template variables.
 *
 * This module wraps the variable half of the docs templates API: list a template's declared
 * variables, add one, and remove one. The one exported response shape is
 * {@link DocumentTemplateVariableSummary}, paired Exact with the API's `DocumentTemplateVariableView`
 * in the contracts gate. Substitution at render and defaults are deferred (NS-13).
 */

/** The value kinds a variable can declare, mirroring the API's `type` union. */
export type DocumentTemplateVariableType = 'text' | 'date' | 'number';

/**
 * One template variable — paired Exact with the API's `DocumentTemplateVariableView`.
 * `organizationId` is absent on both sides: the wire projection never echoes the tenant id.
 */
export interface DocumentTemplateVariableSummary {
  readonly id: string;
  readonly templateId: string;
  readonly key: string;
  readonly label: string;
  readonly type: DocumentTemplateVariableType;
  readonly required: boolean;
  readonly createdAt: string;
}

/** The fields an add sends. Request-side, so the contracts gate does not enumerate it. */
export interface AddDocumentTemplateVariableInput {
  readonly key: string;
  readonly label: string;
  readonly type: DocumentTemplateVariableType;
  readonly required: boolean;
}

function base(organizationSlug: string, templateId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/document-templates/${encodeURIComponent(
    templateId,
  )}/variables`;
}

/** List a template's variables, key-ascending. */
export async function listDocumentTemplateVariables(
  client: ApiClient,
  organizationSlug: string,
  templateId: string,
): Promise<readonly DocumentTemplateVariableSummary[]> {
  const { data } = await client.request<{ variables: readonly DocumentTemplateVariableSummary[] }>({
    path: base(organizationSlug, templateId),
  });
  return data.variables;
}

/** Add a variable to a template. */
export async function addDocumentTemplateVariable(
  client: ApiClient,
  organizationSlug: string,
  templateId: string,
  input: AddDocumentTemplateVariableInput,
): Promise<DocumentTemplateVariableSummary> {
  const { data } = await client.request<DocumentTemplateVariableSummary>({
    method: 'POST',
    path: base(organizationSlug, templateId),
    body: input,
  });
  return data;
}

/** Remove a variable from a template. */
export async function removeDocumentTemplateVariable(
  client: ApiClient,
  organizationSlug: string,
  templateId: string,
  variableId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${base(organizationSlug, templateId)}/${encodeURIComponent(variableId)}`,
  });
}
