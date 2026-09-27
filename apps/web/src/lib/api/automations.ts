import type { ApiClient } from './client';

/**
 * Automations & integrations (module 17, x162).
 *
 * This module wraps the workflow-templates API: list the organization's automation templates and
 * define one. The one exported response shape is {@link WorkflowTemplateSummary}, paired Exact with
 * the API's `WorkflowTemplateView` in the contracts gate. Execution/runs are x163.
 */

/** The events an automation may trigger on. Mirrors the API's `WORKFLOW_TRIGGER_KINDS`. */
export type WorkflowTriggerKind =
  | 'work_item_created'
  | 'work_item_transitioned'
  | 'request_submitted'
  | 'meeting_scheduled'
  | 'document_published';

/** The actions an automation may take. Mirrors the API's `WORKFLOW_ACTION_KINDS`. */
export type WorkflowActionKind =
  'notify_owner' | 'create_work_item' | 'post_message' | 'send_email_digest';

/**
 * One workflow template — paired Exact with the API's `WorkflowTemplateView`. `organizationId` is
 * absent on both sides: the wire projection never echoes the tenant id. `triggerKind`/`actionKind` are
 * `string` (not the unions above), matching the API view exactly — the closed set is enforced server
 * side, and the wire carries whatever token was stored.
 */
export interface WorkflowTemplateSummary {
  readonly id: string;
  readonly name: string;
  readonly triggerKind: string;
  readonly actionKind: string;
  readonly config: Record<string, unknown>;
  readonly enabled: boolean;
  readonly createdBy: string;
  readonly createdAt: string;
}

/** The fields a define sends. Request-side (suffix `Input`), so the contracts gate ignores it. */
export interface CreateWorkflowTemplateInput {
  readonly name: string;
  readonly triggerKind: WorkflowTriggerKind;
  readonly actionKind: WorkflowActionKind;
  readonly config: Record<string, unknown>;
  readonly enabled?: boolean;
}

/**
 * The edited template — paired Exact with the API's `WorkflowTemplateEditView` (x189). Structurally
 * identical to {@link WorkflowTemplateSummary}: the PATCH returns the full updated template, and the
 * wire projection never echoes the tenant id.
 */
export interface WorkflowTemplateEditView {
  readonly id: string;
  readonly name: string;
  readonly triggerKind: string;
  readonly actionKind: string;
  readonly config: Record<string, unknown>;
  readonly enabled: boolean;
  readonly createdBy: string;
  readonly createdAt: string;
}

/**
 * The fields an edit sends — a partial patch (x189). Request-side (suffix `Input`), so the contracts
 * gate ignores it. Only the fields present are written; identity is not editable and is absent.
 */
export interface UpdateWorkflowTemplateInput {
  readonly name?: string;
  readonly triggerKind?: WorkflowTriggerKind;
  readonly actionKind?: WorkflowActionKind;
  readonly config?: Record<string, unknown>;
  readonly enabled?: boolean;
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/automations/templates`;
}

/** List the organization's workflow templates, name-ascending. */
export async function listWorkflowTemplates(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly WorkflowTemplateSummary[]> {
  const { data } = await client.request<{ templates: readonly WorkflowTemplateSummary[] }>({
    path: base(organizationSlug),
  });
  return data.templates;
}

/** Define a workflow template. */
export async function createWorkflowTemplate(
  client: ApiClient,
  organizationSlug: string,
  input: CreateWorkflowTemplateInput,
): Promise<WorkflowTemplateSummary> {
  const { data } = await client.request<WorkflowTemplateSummary>({
    method: 'POST',
    path: base(organizationSlug),
    body: input,
  });
  return data;
}

/** Edit an existing workflow template (x189). Only the fields present in `input` are changed. */
export async function updateWorkflowTemplate(
  client: ApiClient,
  organizationSlug: string,
  templateId: string,
  input: UpdateWorkflowTemplateInput,
): Promise<WorkflowTemplateEditView> {
  const { data } = await client.request<WorkflowTemplateEditView>({
    method: 'PATCH',
    path: `${base(organizationSlug)}/${encodeURIComponent(templateId)}`,
    body: input,
  });
  return data;
}
