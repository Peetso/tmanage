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
 * One workflow run (x163) — paired Exact with the API's `WorkflowRunView`. `organizationId` is absent
 * on both sides. `status` is `string` (not a union), matching the API view exactly — the closed set
 * (`succeeded` | `failed`) is enforced server side, and the wire carries whatever token was recorded.
 * `detail` is an arbitrary object on both.
 */
export interface WorkflowRunSummary {
  readonly id: string;
  readonly templateId: string;
  readonly status: string;
  readonly detail: Record<string, unknown>;
  readonly startedAt: string;
  readonly finishedAt: string;
}

/**
 * One workflow run in the *history list* (x164) — paired Exact with the API's `WorkflowRunHistoryView`.
 * `organizationId` is absent on both sides, and `detail` is absent: the list is bounded, and a run's
 * full detail is read one at a time via {@link getWorkflowRun}. `status` is `string` (not a union),
 * matching the API view exactly — the closed set (`succeeded` | `failed`) is enforced server side.
 */
export interface WorkflowRunHistoryItem {
  readonly id: string;
  readonly templateId: string;
  readonly status: string;
  readonly startedAt: string;
  readonly finishedAt: string;
}

/**
 * One workflow run in *detail* (x164) — paired Exact with the API's `WorkflowRunDetailView`. The list
 * projection plus the run's `detail` object. `organizationId` is absent on both sides; `detail` is an
 * arbitrary object on both.
 */
export interface WorkflowRunDetail {
  readonly id: string;
  readonly templateId: string;
  readonly status: string;
  readonly detail: Record<string, unknown>;
  readonly startedAt: string;
  readonly finishedAt: string;
}

/** The allowlisted run statuses a history filter may select. Mirrors the API's `WORKFLOW_RUN_STATUSES`. */
export type WorkflowRunStatus = 'succeeded' | 'failed';

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

function runsBase(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/automations/runs`;
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

/** Run one workflow template and return the recorded run. */
export async function runWorkflowTemplate(
  client: ApiClient,
  organizationSlug: string,
  templateId: string,
): Promise<WorkflowRunSummary> {
  const { data } = await client.request<WorkflowRunSummary>({
    method: 'POST',
    path: `${base(organizationSlug)}/${encodeURIComponent(templateId)}/run`,
  });
  return data;
}

/**
 * List the organization's workflow runs across all templates, newest first (x164). An optional
 * `status` narrows the list to one allowlisted outcome; the API rejects any other value.
 */
export async function listWorkflowRuns(
  client: ApiClient,
  organizationSlug: string,
  options: { readonly status?: WorkflowRunStatus } = {},
): Promise<readonly WorkflowRunHistoryItem[]> {
  const query = options.status !== undefined ? `?status=${encodeURIComponent(options.status)}` : '';
  const { data } = await client.request<{ runs: readonly WorkflowRunHistoryItem[] }>({
    path: `${runsBase(organizationSlug)}${query}`,
  });
  return data.runs;
}

/** Read one workflow run's detail (x164). */
export async function getWorkflowRun(
  client: ApiClient,
  organizationSlug: string,
  runId: string,
): Promise<WorkflowRunDetail> {
  const { data } = await client.request<WorkflowRunDetail>({
    path: `${runsBase(organizationSlug)}/${encodeURIComponent(runId)}`,
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
