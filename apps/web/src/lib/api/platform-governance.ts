import type { ApiClient } from './client';

/**
 * 56-21 (R46 L2) — Platform admin governance: the two-person rule for risky platform actions, a
 * notice to one company owner, and the quarterly access review's confirm. Shapes mirror the API's
 * `ApprovalView`, `ApprovalsView`, `OwnerNoticeView` (governance.service.ts) and the access
 * review rows (access-review.service.ts).
 */

export type PlatformApprovalStatus = 'pending' | 'approved' | 'rejected' | 'used' | 'expired';

export interface PlatformApprovalView {
  readonly id: string;
  readonly action: string;
  readonly targetId: string;
  readonly targetLabel: string | null;
  readonly reason: string;
  readonly status: PlatformApprovalStatus;
  readonly requestedByEmail: string | null;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly decidedByEmail: string | null;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
  readonly mine: boolean;
}

export interface PlatformApprovalsView {
  readonly policy: { readonly enabled: boolean };
  readonly actions: readonly string[];
  readonly approvals: readonly PlatformApprovalView[];
}

export interface PlatformOwnerNoticeView {
  readonly id: string;
  readonly organizationId: string;
  readonly subject: string;
  readonly severity: string;
  readonly delivery: string;
  readonly sentByEmail: string | null;
  readonly createdAt: string;
}

export interface PlatformAccessReviewRow {
  readonly userId: string | null;
  readonly email: string;
  readonly displayName: string | null;
  readonly source: 'env' | 'db' | 'former';
  readonly preset: string | null;
  readonly status: 'active' | 'disabled' | 'removed';
  readonly twoStep: boolean;
  readonly signIns: number;
  readonly supportSessions: number;
  readonly organizationsEntered: number;
  readonly lastActiveAt: string | null;
  readonly adminId?: string | null;
  readonly permissions?: readonly string[];
  readonly confirmed?: boolean;
}

export interface PlatformAccessReviewView {
  readonly month: string;
  readonly from: string;
  readonly to: string;
  readonly admins: readonly PlatformAccessReviewRow[];
  readonly withoutTwoStep: number;
}

export interface OwnerNoticeInput {
  readonly organizationId: string;
  readonly subject: string;
  readonly body: string;
  readonly severity: 'info' | 'warning' | 'critical';
}

export const PLATFORM_APPROVALS_QUERY_KEY = ['platform', 'approvals'] as const;
export const PLATFORM_OWNER_NOTICES_QUERY_KEY = ['platform', 'owner-notices'] as const;
export const platformAccessReviewQueryKey = (quarter: string) =>
  ['platform', 'access-review', quarter] as const;

export async function fetchPlatformApprovals(client: ApiClient): Promise<PlatformApprovalsView> {
  const { data } = await client.request<PlatformApprovalsView>({ path: '/v1/platform/approvals' });
  return data;
}

export async function setPlatformTwoPersonPolicy(
  client: ApiClient,
  enabled: boolean,
  reason: string,
): Promise<{ readonly enabled: boolean }> {
  const { data } = await client.request<{ readonly enabled: boolean }>({
    method: 'POST',
    path: '/v1/platform/approvals/policy',
    body: { enabled, reason },
  });
  return data;
}

export async function decidePlatformApproval(
  client: ApiClient,
  id: string,
  decision: 'approve' | 'reject',
  note: string | null,
): Promise<PlatformApprovalView> {
  const { data } = await client.request<PlatformApprovalView>({
    method: 'POST',
    path: `/v1/platform/approvals/${encodeURIComponent(id)}/${decision}`,
    body: note === null ? {} : { note },
  });
  return data;
}

export async function listPlatformOwnerNotices(
  client: ApiClient,
): Promise<readonly PlatformOwnerNoticeView[]> {
  const { data } = await client.request<{ notices: readonly PlatformOwnerNoticeView[] }>({
    path: '/v1/platform/owner-notices',
  });
  return data.notices;
}

export async function sendPlatformOwnerNotice(
  client: ApiClient,
  input: OwnerNoticeInput,
): Promise<PlatformOwnerNoticeView> {
  const { data } = await client.request<PlatformOwnerNoticeView>({
    method: 'POST',
    path: '/v1/platform/owner-notices',
    body: input,
  });
  return data;
}

export async function fetchPlatformAccessReview(
  client: ApiClient,
  quarter: string,
): Promise<PlatformAccessReviewView> {
  const { data } = await client.request<PlatformAccessReviewView>({
    path: `/v1/platform/team/access-review?quarter=${encodeURIComponent(quarter)}`,
  });
  return data;
}

export async function confirmPlatformAccess(
  client: ApiClient,
  period: string,
  userId: string,
): Promise<{ readonly period: string; readonly userId: string; readonly confirmed: true }> {
  const { data } = await client.request<{
    readonly period: string;
    readonly userId: string;
    readonly confirmed: true;
  }>({
    method: 'POST',
    path: '/v1/platform/team/access-review/confirm',
    body: { period, userId },
  });
  return data;
}

/** `YYYY-Qn` for a date, and the quarters a review may pick (this one and the three before). */
export function quarterOf(at: Date): string {
  return `${String(at.getUTCFullYear())}-Q${String(Math.floor(at.getUTCMonth() / 3) + 1)}`;
}

export function recentQuarters(now: Date, count = 4): readonly string[] {
  const out: string[] = [];
  let year = now.getUTCFullYear();
  let quarter = Math.floor(now.getUTCMonth() / 3) + 1;
  for (let i = 0; i < count; i += 1) {
    out.push(`${String(year)}-Q${String(quarter)}`);
    quarter -= 1;
    if (quarter === 0) {
      quarter = 4;
      year -= 1;
    }
  }
  return out;
}
