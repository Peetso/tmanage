import type { ApiClient } from './client';
import { REAUTH_HEADER } from './passkeys';

/**
 * Confirm-class AI approvals (MCP connector S10) — the approve page's API. A cookie session of
 * the member the AI app asked for reads one pending action, then approves (the server runs the
 * frozen action once) or declines it. Any other member gets a 404. Mirrors `PendingAiActionView`
 * in `apps/api/src/modules/mcp/pending-actions.service.ts`.
 */

export type AiApprovalStatus = 'pending' | 'approved' | 'declined' | 'expired' | 'failed';

/**
 * AI panel gap 3: `step_up` is a money or HR action. Show "Review" (the step-up card), never a
 * one-click Approve; the server refuses an approve without a fresh step-up and, when `amount` is
 * set, without that amount typed back.
 */
export type AiApprovalConfirmation = 'none' | 'step_up';

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
  /**
   * ADR-0015 F9: only on a Platform admin action. The platform permission used, whether another
   * admin must also approve while the two-person rule is on, and the reason the AI drafted, which
   * the person approves as theirs.
   */
  readonly platform?: {
    readonly permission: string | null;
    readonly secondAdminWhenPolicyOn: boolean;
    readonly reason: string | null;
    readonly reasonDraftedByAi: boolean;
  };
}

export interface AiApprovalView {
  readonly id: string;
  readonly status: AiApprovalStatus;
  readonly clientName: string;
  readonly memberName: string;
  readonly memberEmail: string;
  readonly summary: AiApprovalSummary;
  readonly confirmation: AiApprovalConfirmation;
  /** The amount a money approval types back; `null` when none is asked. */
  readonly amount: number | null;
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

/**
 * 55-15p: the signed-in member's own actions waiting for approval, newest first (cookie session
 * only) — the "AI actions" list, its menu badge and the AI assistant page's waiting card.
 */
export async function listPendingAiApprovals(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly AiApprovalView[]> {
  const { data } = await client.request<{ readonly items: readonly AiApprovalView[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/ai/approvals`,
  });
  return data.items;
}

/** The query key every reader of the waiting list shares, so the menu and the page ask once. */
export function pendingAiApprovalsKey(organizationSlug: string): readonly string[] {
  return ['ai-approvals-pending', organizationSlug];
}

/** A `step_up` approve's proof: the step-up token and, for money, the amount typed back. */
export interface AiApprovalStepUpInput {
  readonly reauthToken?: string;
  readonly amount?: number;
}

export async function decideAiApproval(
  client: ApiClient,
  organizationSlug: string,
  id: string,
  decision: 'approve' | 'decline',
  stepUp: AiApprovalStepUpInput = {},
): Promise<AiApprovalView> {
  const { data } = await client.request<AiApprovalView>({
    method: 'POST',
    path: `${approvalPath(organizationSlug, id)}/${decision}`,
    ...(stepUp.amount === undefined ? {} : { body: { amount: stepUp.amount } }),
    ...(stepUp.reauthToken === undefined
      ? {}
      : { headers: { [REAUTH_HEADER]: stepUp.reauthToken } }),
  });
  return data;
}
