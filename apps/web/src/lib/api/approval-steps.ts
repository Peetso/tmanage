import type { ApiClient } from './client';

/**
 * The sequential approval-steps endpoints (x315) — the ordered chain over an approval.
 *
 * A member defines an ordered set of steps (each an approver role at a position), advances the chain
 * by deciding the active step, and reads the chain with the id of the active step highlighted. This
 * is the internal chain surface, distinct from the client deep-link projection in `approvals.ts`.
 */

/** One step's decision state — mirrors the API's `ApprovalStepState`. */
export type ApprovalStepState = 'pending' | 'approved' | 'rejected';

/** One step in the chain — the API's `ApprovalStepView`. No tenant id crosses the wire. */
export interface ApprovalStep {
  readonly id: string;
  readonly approvalId: string;
  readonly position: number;
  readonly approverRole: string;
  readonly approverUserId: string | null;
  readonly state: ApprovalStepState;
  readonly decidedBy: string | null;
  /** An ISO-8601 instant, or null while pending. */
  readonly decidedAt: string | null;
}

/**
 * The chain as read — the API's `ApprovalChainView`. `activeStepId` is the lowest position still
 * pending (the step the screen highlights and offers approve/reject on), or null when all are decided.
 */
export interface ApprovalChain {
  readonly steps: readonly ApprovalStep[];
  readonly activeStepId: string | null;
}

/** One step to define. `approverUserId` is optional — omitted means "any holder of the role". */
export interface DefineApprovalStep {
  readonly position: number;
  readonly approverRole: string;
  readonly approverUserId?: string | null;
}

export async function listApprovalSteps(
  client: ApiClient,
  organizationSlug: string,
  approvalId: string,
): Promise<ApprovalChain> {
  const { data } = await client.request<ApprovalChain>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/approvals/${encodeURIComponent(approvalId)}/steps`,
  });
  return data;
}

export async function defineApprovalSteps(
  client: ApiClient,
  organizationSlug: string,
  approvalId: string,
  steps: readonly DefineApprovalStep[],
): Promise<ApprovalChain> {
  const { data } = await client.request<ApprovalChain>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/approvals/${encodeURIComponent(approvalId)}/steps`,
    body: { steps },
  });
  return data;
}

export async function decideApprovalStep(
  client: ApiClient,
  organizationSlug: string,
  approvalId: string,
  stepId: string,
  decision: 'approve' | 'reject',
): Promise<ApprovalChain> {
  const { data } = await client.request<ApprovalChain>({
    method: 'PUT',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/approvals/${encodeURIComponent(approvalId)}/steps/${encodeURIComponent(stepId)}`,
    body: { decision },
  });
  return data;
}
