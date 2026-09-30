import type { ApiClient } from './client';

/**
 * Plan-change requests — Billing / module 19 (x284), behind the plan-change-request screen.
 *
 * This module wraps the requests API: list the organization's plan-change requests, create one, and
 * cancel one. The one exported response shape is {@link PlanChangeRequestView}, mirroring the API's
 * `PlanChangeRequestView`.
 *
 * Every read and write is gated on the server by `org.manage` — owners only — so a member who reaches
 * this client gets the ordinary 403 the shared client turns into an error; there is no organization-id
 * argument here, because the tenant is the slug in the path resolved against the caller's membership,
 * never a value the caller supplies. A request is a recorded intent only: this client never charges,
 * calls a provider, or changes an entitlement.
 */

/**
 * One plan-change request — mirroring the API's `PlanChangeRequestView`. `organizationId` is absent:
 * the wire projection never echoes the tenant id. Every money/entitlement concern is deliberately
 * off-shape — the request records only *which* plan an admin asked to move to and when.
 */
export interface PlanChangeRequestView {
  readonly id: string;
  readonly targetPlanCode: string;
  /** An ISO-8601 calendar date (`YYYY-MM-DD`). */
  readonly effectiveOn: string;
  readonly note: string | null;
  readonly status: string;
  readonly createdBy: string;
  /** An ISO-8601 instant. */
  readonly createdAt: string;
}

/** The fields a create sends. Request-side (suffix `Input`), off the contracts shape check. */
export interface CreatePlanChangeRequestInput {
  readonly targetPlanCode: string;
  readonly effectiveOn: string;
  readonly note?: string | null;
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/billing/plan-change-requests`;
}

/** List the organization's plan-change requests, newest-first. */
export async function listPlanChangeRequests(
  client: ApiClient,
  organizationSlug: string,
): Promise<{ readonly requests: readonly PlanChangeRequestView[] }> {
  const { data } = await client.request<{ readonly requests: readonly PlanChangeRequestView[] }>({
    path: base(organizationSlug),
  });
  return data;
}

/** Create a plan-change request. */
export async function createPlanChangeRequest(
  client: ApiClient,
  organizationSlug: string,
  input: CreatePlanChangeRequestInput,
): Promise<PlanChangeRequestView> {
  const { data } = await client.request<PlanChangeRequestView>({
    method: 'POST',
    path: base(organizationSlug),
    body: input,
  });
  return data;
}

/** Cancel a plan-change request. Idempotent on the server. */
export async function cancelPlanChangeRequest(
  client: ApiClient,
  organizationSlug: string,
  requestId: string,
): Promise<PlanChangeRequestView> {
  const { data } = await client.request<PlanChangeRequestView>({
    method: 'PUT',
    path: `${base(organizationSlug)}/${encodeURIComponent(requestId)}/cancel`,
  });
  return data;
}
