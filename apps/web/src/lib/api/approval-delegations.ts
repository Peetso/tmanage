import type { ApiClient } from './client';

/**
 * Approval delegation (x300) — an approver delegates their own approval authority to another member
 * for a window, lists their delegations, and revokes one. Create and revoke are behind the API's
 * `approval.decide`, the list behind `approval.read`; a caller without the capability gets the ordinary
 * 403 the shared client turns into an error. The delegator is always the acting member — never a value
 * this client supplies — and the tenant is the slug in the path resolved against the caller's
 * membership. This module wraps only what the delegation screen consumes, the discipline the contracts
 * gate enforces on this folder.
 */

/**
 * One of the caller's delegations — paired Exact with the API's `ApprovalDelegationView` in the
 * contracts gate (`e2e/contracts/api-web-shapes.ts`). The delegator is always the caller and so is not
 * echoed; `organizationId` is absent on both sides — the wire projection never echoes the tenant id.
 */
export interface ApprovalDelegationSummary {
  readonly id: string;
  readonly delegateMembershipId: string;
  /** ISO-8601 instant — the window opens. */
  readonly startsAt: string;
  /** ISO-8601 instant — the window closes. */
  readonly endsAt: string;
  /** ISO-8601 instant. */
  readonly createdAt: string;
}

/** What the caller posts to delegate their approval authority. Request-side; not a response shape. */
export interface CreateApprovalDelegationInput {
  readonly delegateMembershipId: string;
  readonly startsAt: string;
  readonly endsAt: string;
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/approvals/delegations`;
}

/** Delegate the caller's approval authority to another member for a window. */
export async function createApprovalDelegation(
  client: ApiClient,
  organizationSlug: string,
  input: CreateApprovalDelegationInput,
): Promise<ApprovalDelegationSummary> {
  const { data } = await client.request<ApprovalDelegationSummary>({
    method: 'POST',
    path: base(organizationSlug),
    body: {
      delegateMembershipId: input.delegateMembershipId,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
    },
  });
  return data;
}

/** List the caller's own delegations, newest first. */
export async function listApprovalDelegations(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly ApprovalDelegationSummary[]> {
  const { data } = await client.request<{ delegations: readonly ApprovalDelegationSummary[] }>({
    path: base(organizationSlug),
  });
  return data.delegations;
}

/** Revoke one of the caller's delegations. Idempotent: an unknown id is still success. */
export async function revokeApprovalDelegation(
  client: ApiClient,
  organizationSlug: string,
  delegationId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${base(organizationSlug)}/${encodeURIComponent(delegationId)}`,
  });
}
