import type { AutomationFlow, AutomationFlowIssue } from '@tmanage/domain';
import type { ApiClient } from './client';
import { createWorkflowTemplate, type WorkflowTriggerKind } from './automations';

/**
 * 58-C1 — the branching rule builder's API: the graph in force for one rule, saving a new version
 * of it, and turning the rule on once every step is finished.
 */

/**
 * The builder's read — paired Exact with the API's `WorkflowFlowView`. `version` is `null` for a
 * linear rule never saved in the builder (its graph is the one-step, branch-less graph).
 */
export interface WorkflowFlowSummary {
  readonly templateId: string;
  readonly version: number | null;
  readonly flow: AutomationFlow;
  readonly issues: readonly AutomationFlowIssue[];
  readonly enabled: boolean;
}

function flowPath(organizationSlug: string, templateId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/automations/templates/${encodeURIComponent(templateId)}/flow`;
}

/** Read the graph in force. */
export async function getWorkflowFlow(
  client: ApiClient,
  organizationSlug: string,
  templateId: string,
): Promise<WorkflowFlowSummary> {
  const { data } = await client.request<WorkflowFlowSummary>({
    path: flowPath(organizationSlug, templateId),
  });
  return data;
}

/** Save the graph as the rule's next version. */
export async function saveWorkflowFlow(
  client: ApiClient,
  organizationSlug: string,
  templateId: string,
  flow: AutomationFlow,
): Promise<WorkflowFlowSummary> {
  const { data } = await client.request<WorkflowFlowSummary>({
    method: 'PUT',
    path: flowPath(organizationSlug, templateId),
    body: { flow },
  });
  return data;
}

/** Turn the rule on; the API refuses while a step is unfinished. */
export async function turnOnWorkflowFlow(
  client: ApiClient,
  organizationSlug: string,
  templateId: string,
): Promise<WorkflowFlowSummary> {
  const { data } = await client.request<WorkflowFlowSummary>({
    method: 'POST',
    path: `${flowPath(organizationSlug, templateId)}/turn-on`,
  });
  return data;
}

/**
 * Start a new branching rule from the builder's empty state: the rule is created off, with the
 * picked trigger, and its graph is saved with no steps yet. Returns the new rule's id.
 */
export async function createBranchingRule(
  client: ApiClient,
  organizationSlug: string,
  triggerKind: WorkflowTriggerKind,
  name: string,
): Promise<string> {
  const template = await createWorkflowTemplate(client, organizationSlug, {
    name,
    triggerKind,
    actionKind: 'notify_owner',
    config: {},
    enabled: false,
  });
  await saveWorkflowFlow(client, organizationSlug, template.id, { start: null, nodes: [] });
  return template.id;
}
