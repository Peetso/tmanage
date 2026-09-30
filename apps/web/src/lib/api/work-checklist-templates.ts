import type { ApiClient } from './client';

/**
 * Reusable work-item checklist templates (module 7, x292).
 *
 * This module wraps the checklist-templates API: list and define org-scoped templates, delete one,
 * and apply one to a work item to seed its checklist. Two response shapes are exported and paired in
 * the contracts gate — {@link ChecklistTemplate} (Exact with the API's `ChecklistTemplateView`) and
 * {@link ApplyTemplateResult} (Exact with `ApplyTemplateResultView`). `organizationId` is absent on
 * both, as on every wire projection.
 */

/** One checklist template — paired Exact with the API's `ChecklistTemplateView`. */
export interface ChecklistTemplate {
  readonly id: string;
  readonly name: string;
  readonly labels: readonly string[];
  readonly createdAt: string;
}

/** The result of applying a template to a work item — paired Exact with `ApplyTemplateResultView`. */
export interface ApplyTemplateResult {
  readonly workItemId: string;
  readonly templateId: string;
  readonly seeded: number;
}

/** The fields a define sends. Request-side (suffix `Input`), so the contracts gate ignores it. */
export interface DefineChecklistTemplateInput {
  readonly name: string;
  readonly labels: readonly string[];
}

function orgBase(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}`;
}

/** List the organization's checklist templates, name-ascending. */
export async function listChecklistTemplates(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly ChecklistTemplate[]> {
  const { data } = await client.request<{ templates: readonly ChecklistTemplate[] }>({
    path: `${orgBase(organizationSlug)}/work/checklist-templates`,
  });
  return data.templates;
}

/** Define a checklist template. */
export async function defineChecklistTemplate(
  client: ApiClient,
  organizationSlug: string,
  input: DefineChecklistTemplateInput,
): Promise<ChecklistTemplate> {
  const { data } = await client.request<ChecklistTemplate>({
    method: 'POST',
    path: `${orgBase(organizationSlug)}/work/checklist-templates`,
    body: { name: input.name, labels: input.labels },
  });
  return data;
}

/** Remove a checklist template. */
export async function deleteChecklistTemplate(
  client: ApiClient,
  organizationSlug: string,
  templateId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${orgBase(organizationSlug)}/work/checklist-templates/${encodeURIComponent(templateId)}`,
  });
}

/** Apply a template to a work item, seeding its checklist (idempotent). */
export async function applyChecklistTemplate(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  templateId: string,
): Promise<ApplyTemplateResult> {
  const { data } = await client.request<ApplyTemplateResult>({
    method: 'POST',
    path: `${orgBase(organizationSlug)}/work-items/${encodeURIComponent(
      workItemId,
    )}/apply-checklist-template/${encodeURIComponent(templateId)}`,
  });
  return data;
}
