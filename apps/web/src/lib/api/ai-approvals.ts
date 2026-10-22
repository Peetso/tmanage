import type { ApiClient } from './client';

/**
 * Confirm-class AI approvals (MCP connector S10) — the approve page's API. A cookie session of
 * the member the AI app asked for reads one pending action, then approves (the server runs the
 * frozen action once) or declines it. Any other member gets a 404. Mirrors `PendingAiActionView`
 * in `apps/api/src/modules/mcp/pending-actions.service.ts`.
 */

export type AiApprovalStatus = 'pending' | 'approved' | 'declined' | 'expired' | 'failed';

export interface AiApprovalField {
  readonly name: string;
  readonly value: string;
}

/** Built by the server from the action registry and the frozen arguments — never by the AI. */
export interface AiApprovalSummary {
  readonly opId: string;
  readonly title: string;
  readonly method: string;
  readonly destructive: boolean;
  readonly notifies: boolean;
  /** What the action is about (a work item's title, an invitee's email); null when unknown. */
  readonly subject: string | null;
  readonly fields: readonly AiApprovalField[];
}

export interface AiApprovalView {
  readonly id: string;
  readonly status: AiApprovalStatus;
  readonly clientName: string;
  readonly memberName: string;
  readonly memberEmail: string;
  readonly summary: AiApprovalSummary;
  readonly expiresAt: string;
  readonly decidedAt: string | null;
}

function approvalPath(organizationSlug: string, id: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/ai/approvals/${encodeURIComponent(id)}`;
}

export async function getAiApproval(
  client: ApiClient,
  organizationSlug: string,
  id: string,
): Promise<AiApprovalView> {
  const { data } = await client.request<AiApprovalView>({
    path: approvalPath(organizationSlug, id),
  });
  return data;
}

export async function decideAiApproval(
  client: ApiClient,
  organizationSlug: string,
  id: string,
  decision: 'approve' | 'decline',
): Promise<AiApprovalView> {
  const { data } = await client.request<AiApprovalView>({
    method: 'POST',
    path: `${approvalPath(organizationSlug, id)}/${decision}`,
  });
  return data;
}
