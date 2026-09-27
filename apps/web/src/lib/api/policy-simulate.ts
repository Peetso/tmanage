import type { ApiClient } from './client';

/**
 * Access-policy simulation (Administration module 18, x196).
 *
 * Wraps the read-only "can member X do Y?" API: given a member, a capability and an optional resource
 * context, it returns the decision the live evaluator would reach, with the deciding rule made explicit.
 * The one exported response shape is {@link PolicySimulationView}, paired Exact with the API's
 * `PolicySimulationView` in the contracts gate.
 *
 * Distinct from x174 `policies.ts` (the stored access-policy document): this evaluates the *effect* of
 * the stored roles and policies on one member, and never mutates anything.
 */

/** The resource facts to evaluate against. All optional; each defaults to an org-level internal read. */
export interface PolicySimulationContextInput {
  readonly projectId?: string | null;
  readonly audience?: 'internal' | 'client_visible' | 'client_action_required';
}

/** The POST body — which member, which capability, and the resource context. Request-side, not paired. */
export interface PolicySimulationInput {
  readonly memberId: string;
  readonly capability: string;
  readonly context?: PolicySimulationContextInput;
}

/** The simulated decision — paired Exact with the API. A 200 body; `denialCode` is null when allowed. */
export interface PolicySimulationView {
  readonly result: {
    readonly memberId: string;
    readonly role: string;
    readonly capability: string;
    readonly allowed: boolean;
    readonly decidingRule: string;
    readonly detail: string;
    readonly denialCode: string | null;
  };
}

function endpoint(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/policies/simulate`;
}

/** Simulate a single access decision. Read-only; the API writes nothing. */
export async function simulatePolicy(
  client: ApiClient,
  organizationSlug: string,
  input: PolicySimulationInput,
): Promise<PolicySimulationView> {
  const { data } = await client.request<PolicySimulationView>({
    method: 'POST',
    path: endpoint(organizationSlug),
    body: input,
  });
  return data;
}
