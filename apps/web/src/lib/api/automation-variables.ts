import type { ApiClient } from './client';

/**
 * Automation variables (module 17, x305).
 *
 * This module wraps the org-level, **non-secret** automation-variable API: list the organization's
 * variables, upsert one by key, and remove one. The one exported response shape is
 * {@link AutomationVariableSummary}, paired Exact with the API's `AutomationVariableView` in the
 * contracts gate. Secrets/credentials are out of scope — a secret-like key name is the API's 400.
 */

/**
 * One automation variable — paired Exact with the API's `AutomationVariableView`. Neither side echoes
 * the row id or the tenant id: a variable is addressed by its `key` within the acting organization.
 */
export interface AutomationVariableSummary {
  readonly key: string;
  readonly value: string;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/automations/variables`;
}

/** List the organization's automation variables, key-ascending. */
export async function listAutomationVariables(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly AutomationVariableSummary[]> {
  const { data } = await client.request<{ variables: readonly AutomationVariableSummary[] }>({
    path: base(organizationSlug),
  });
  return data.variables;
}

/** Create or replace one automation variable by key. */
export async function upsertAutomationVariable(
  client: ApiClient,
  organizationSlug: string,
  key: string,
  value: string,
): Promise<AutomationVariableSummary> {
  const { data } = await client.request<AutomationVariableSummary>({
    method: 'PUT',
    path: `${base(organizationSlug)}/${encodeURIComponent(key)}`,
    body: { value },
  });
  return data;
}

/** Remove one automation variable by key. Idempotent: a 204 whether or not the key existed. */
export async function deleteAutomationVariable(
  client: ApiClient,
  organizationSlug: string,
  key: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${base(organizationSlug)}/${encodeURIComponent(key)}`,
  });
}
