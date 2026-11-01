import type { ApiClient } from './client';
import type { WorkItemSummary } from './work-items';

/**
 * WORK intake forms (module 7, x146).
 *
 * This module wraps the work-forms API: list the organization's forms, define one, and submit one to
 * create a work item. The one exported response shape is {@link WorkFormSummary}, paired Exact with
 * the API's `WorkFormView` in the contracts gate. A submission's response is the created
 * {@link WorkItemSummary} — WORK-001 owns that pairing, so it is reused, not re-declared here.
 *
 * The field-definition shape is a `type` alias (an object literal / a string-literal union), which
 * the contracts gate deliberately does not enumerate — it is part of the form's response, carried
 * inside {@link WorkFormSummary}, not a projection of its own.
 */

/** The field types a form can declare. Mirrors the API's `WorkFormFieldType`. */
export type WorkFormFieldType = 'text' | 'number' | 'date' | 'checkbox';

/** One field definition inside a form. Mirrors the API's `WorkFormFieldDef`. */
export type WorkFormFieldDef = {
  readonly label: string;
  readonly type: WorkFormFieldType;
  readonly required: boolean;
};

/**
 * One work form — paired Exact with the API's `WorkFormView`. `organizationId` is absent on both
 * sides: the wire projection never echoes the tenant id.
 */
export interface WorkFormSummary {
  readonly id: string;
  readonly name: string;
  readonly fields: readonly WorkFormFieldDef[];
  readonly createdBy: string;
  readonly createdAt: string;
  /** Whether the form has a live public link (`/f/<publicSlug>`). */
  readonly published: boolean;
  /** The public link's slug while published; `null` when the form is not shared. */
  readonly publicSlug: string | null;
}

/** `POST …/work-forms/:id/publish|unpublish`. Mirrors the API's `PublicFormState`. */
export interface PublicFormState {
  readonly published: boolean;
  readonly slug: string | null;
}

/** The fields a define sends. Request-side (suffix `Input`), so the contracts gate ignores it. */
export interface CreateWorkFormInput {
  readonly name: string;
  readonly fields: readonly WorkFormFieldDef[];
}

/** The payload a submission sends. Request-side (suffix `Input`), so the contracts gate ignores it. */
export interface SubmitWorkFormInput {
  readonly projectId: string;
  readonly title: string;
  readonly values: Record<string, string | number | boolean>;
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-forms`;
}

/** List the organization's work forms, name-ascending. */
export async function listWorkForms(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly WorkFormSummary[]> {
  const { data } = await client.request<{ forms: readonly WorkFormSummary[] }>({
    path: base(organizationSlug),
  });
  return data.forms;
}

/** Define a work form. */
export async function createWorkForm(
  client: ApiClient,
  organizationSlug: string,
  input: CreateWorkFormInput,
): Promise<WorkFormSummary> {
  const { data } = await client.request<WorkFormSummary>({
    method: 'POST',
    path: base(organizationSlug),
    body: input,
  });
  return data;
}

/** Submit a form — validates the payload against its fields and creates a work item. */
export async function submitWorkForm(
  client: ApiClient,
  organizationSlug: string,
  formId: string,
  input: SubmitWorkFormInput,
): Promise<WorkItemSummary> {
  const { data } = await client.request<WorkItemSummary>({
    method: 'POST',
    path: `${base(organizationSlug)}/${encodeURIComponent(formId)}/submissions`,
    body: input,
  });
  return data;
}

/** Share a form on a public link (`/f/<slug>`). Idempotent: an already-public form keeps its slug. */
export async function publishWorkForm(
  client: ApiClient,
  organizationSlug: string,
  formId: string,
): Promise<PublicFormState> {
  const { data } = await client.request<PublicFormState>({
    method: 'POST',
    path: `${base(organizationSlug)}/${encodeURIComponent(formId)}/publish`,
  });
  return data;
}

/** Stop sharing a form: its public link answers "not found" straight away. */
export async function unpublishWorkForm(
  client: ApiClient,
  organizationSlug: string,
  formId: string,
): Promise<PublicFormState> {
  const { data } = await client.request<PublicFormState>({
    method: 'POST',
    path: `${base(organizationSlug)}/${encodeURIComponent(formId)}/unpublish`,
  });
  return data;
}
