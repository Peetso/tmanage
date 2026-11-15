import type { ApprovalState } from '@tmanage/domain';
import type { ApiClient } from './client';

/**
 * The client deep-link's endpoints — FR-05's client-facing view and decision.
 *
 * A separate module from the internal approvals surface (which `apps/web` does not have): these
 * are the **client projection**, the allowlisted client-safe view a client reads through
 * `client_projection.read`, and the decision they post against it. `25-AUTH-AND-TENANT-ISOLATION`
 * §7 forbids building the client view by removing fields from the internal record, and the API
 * keeps the two apart — the client decide returns {@link ClientDecideResult}, never the internal
 * `ApprovalDecisionView` with its `reviewerIds` and `contentHash`.
 */

/**
 * The allowlisted client-safe payload — 12-PERMISSION-MATRIX §1 and no more. Mirrors the API's
 * `ClientProjectionPayload`; a field the internal record carries but this omits (cost, estimates,
 * staff review, private threads, risk rationale) is one a client can never be shown.
 */
interface ClientApprovalProjection {
  readonly title: string;
  readonly summary: string | null;
  readonly milestoneState: string | null;
  readonly forecastDate: string | null;
  readonly publishedRisk: string | null;
  readonly decision: string | null;
  readonly approvedContacts: readonly string[];
}

/**
 * The immutable client projection the deep-link screen renders — the API's `ClientProjectionView`.
 *
 * `publishedAt` is an ISO string on the wire; `contentHash` is the frozen version identity the
 * projection was published for, which the decide posts back to.
 */
export interface ClientApprovalView {
  readonly id: string;
  readonly deliverableId: string;
  readonly deliverableVersionId: string;
  readonly contentHash: string;
  readonly projection: ClientApprovalProjection;
  readonly publishedByUserId: string;
  readonly publishedAt: string;
  /**
   * Whether this reader is asked to decide: true only after "Send for approval" named them (or,
   * for a staff preview, while an approval is pending). A version only shared opens as viewing.
   */
  readonly awaitingDecision: boolean;
}

/**
 * The client-safe confirmation of a decision — the API's `ClientDecideView`.
 *
 * Deliberately not the internal decision record: the version decided on, the resulting lifecycle
 * `state`, when it was decided, and the note for a change request. `state` is `invalidated` when
 * the governed content changed under the client before they decided (INT-17).
 */
export interface ClientDecideResult {
  readonly deliverableVersionId: string;
  readonly state: ApprovalState;
  readonly decidedAt: string | null;
  readonly feedback: string | null;
}

/** The decision the client posts. `feedback` is required for `request_changes` (the API enforces it). */
export interface ClientDecideInput {
  readonly decision: 'approve' | 'request_changes';
  readonly feedback?: string;
}

export async function getClientApproval(
  client: ApiClient,
  organizationSlug: string,
  deliverableVersionId: string,
): Promise<ClientApprovalView> {
  const { data } = await client.request<ClientApprovalView>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/approvals/projections/${encodeURIComponent(deliverableVersionId)}`,
  });
  return data;
}

export async function decideClientApproval(
  client: ApiClient,
  organizationSlug: string,
  deliverableVersionId: string,
  input: ClientDecideInput,
): Promise<ClientDecideResult> {
  const { data } = await client.request<ClientDecideResult>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/approvals/projections/${encodeURIComponent(deliverableVersionId)}/decision`,
    body: {
      decision: input.decision,
      ...(input.feedback !== undefined ? { feedback: input.feedback } : {}),
    },
  });
  return data;
}
