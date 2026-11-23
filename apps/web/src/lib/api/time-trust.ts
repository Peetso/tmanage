import type { ApiClient } from './client';

/**
 * Time you can trust (owner rule, 2026-11-23) — the web half of `time/time-trust.controller.ts`.
 * Each type is the mirror of an API view, paired `Exact` in `e2e/contracts/api-web-shapes.ts`.
 */

const org = (slug: string): string => `/v1/organizations/${encodeURIComponent(slug)}`;

/** The query key every time surface shares, so a saved change reaches "Log time" at once. */
export const timeTrustKey = (slug: string) => ['time-trust-policy', slug] as const;

export type HandTimeCountMode = 'after_approval' | 'at_once_flagged';

/** Admin > Time: the owner's rules for time added by hand. */
export interface TimeTrustPolicy {
  readonly handTimeAllowed: boolean;
  readonly handTimeCountMode: HandTimeCountMode;
  readonly idleCapHours: number;
  /** The caller is the company owner and may change the rules. */
  readonly mayChange: boolean;
}

export interface TimeTrustEntry {
  readonly id: string;
  readonly membershipId: string;
  readonly workItemId: string | null;
  readonly workItemTitle: string | null;
  readonly projectId: string | null;
  readonly spentOn: string;
  readonly minutes: number;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly billable: boolean;
  readonly source: 'manual' | 'timer' | 'automatic' | 'correction';
  readonly trust: 'measured' | 'hand';
  readonly approvalState: 'none' | 'pending' | 'approved' | 'rejected';
  readonly counted: boolean;
  readonly needsReview: boolean;
  readonly reason: string | null;
  readonly correctsEntryId: string | null;
  readonly supersededBy: string | null;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
  readonly edited: boolean;
  readonly createdAt: string;
  readonly mayDecide: boolean;
}

export interface TimeApprovalQueue {
  readonly entries: readonly TimeTrustEntry[];
  readonly pendingMinutes: number;
}

export interface TimeEntryHistory {
  readonly entry: TimeTrustEntry;
  readonly original: TimeTrustEntry | null;
  readonly corrections: readonly TimeTrustEntry[];
}

export async function readTimeTrustPolicy(
  client: ApiClient,
  slug: string,
): Promise<TimeTrustPolicy> {
  const { data } = await client.request<TimeTrustPolicy>({
    path: `${org(slug)}/time/trust-policy`,
  });
  return data;
}

export async function saveTimeTrustPolicy(
  client: ApiClient,
  slug: string,
  input: Partial<Omit<TimeTrustPolicy, 'mayChange'>>,
): Promise<TimeTrustPolicy> {
  const { data } = await client.request<TimeTrustPolicy>({
    method: 'PATCH',
    path: `${org(slug)}/time/trust-policy`,
    body: input,
  });
  return data;
}

export async function listTimeApprovals(
  client: ApiClient,
  slug: string,
): Promise<TimeApprovalQueue> {
  const { data } = await client.request<TimeApprovalQueue>({
    path: `${org(slug)}/time/approvals`,
  });
  return data;
}

export async function decideTimeEntry(
  client: ApiClient,
  slug: string,
  entryId: string,
  approve: boolean,
  note?: string,
): Promise<TimeTrustEntry> {
  const { data } = await client.request<TimeTrustEntry>({
    method: 'POST',
    path: `${org(slug)}/time/approvals/${encodeURIComponent(entryId)}/${approve ? 'approve' : 'reject'}`,
    body: note === undefined || note === '' ? {} : { note },
  });
  return data;
}

export async function requestTimeCorrection(
  client: ApiClient,
  slug: string,
  entryId: string,
  input: { readonly minutes: number; readonly reason: string },
): Promise<TimeTrustEntry> {
  const { data } = await client.request<TimeTrustEntry>({
    method: 'POST',
    path: `${org(slug)}/time/entries/${encodeURIComponent(entryId)}/correction`,
    body: input,
  });
  return data;
}

export async function readTimeEntryHistory(
  client: ApiClient,
  slug: string,
  entryId: string,
): Promise<TimeEntryHistory> {
  const { data } = await client.request<TimeEntryHistory>({
    path: `${org(slug)}/time/entries/${encodeURIComponent(entryId)}/history`,
  });
  return data;
}
