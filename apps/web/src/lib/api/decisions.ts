import type { ApiClient } from './client';

/**
 * The decision-register endpoints — DEC-01 (x113), gated on `meeting.read` / `meeting.write` (the
 * register reuses the calendar's capabilities this slice).
 *
 * Two shapes here are the API's own:
 *
 * - **A decision is authored, not edited.** `POST …/decisions` records a decision on the register;
 *   there is no update surface this slice — the status transitions and supersede edges are a later
 *   slice. The row that comes back is the decision that now exists.
 * - **The register is a project's.** `GET …/decisions?projectId=` lists one project's decisions,
 *   most recently decided first, tenant-scoped by the API.
 */

/** Where a decision sits in its short lifecycle. Mirrors the API's `DecisionStatus`. */
export type DecisionStatus = 'proposed' | 'accepted' | 'superseded';

export interface DecisionSummary {
  readonly id: string;
  readonly projectId: string;
  /** The meeting the decision was taken in, when there was one. */
  readonly meetingId: string | null;
  readonly title: string;
  readonly statement: string;
  readonly status: DecisionStatus;
  readonly decidedBy: string;
  /** An ISO-8601 instant. */
  readonly decidedAt: string;
  readonly createdAt: string;
}

export async function listDecisions(
  client: ApiClient,
  organizationSlug: string,
  query: { readonly projectId: string; readonly limit?: number },
): Promise<readonly DecisionSummary[]> {
  const parameters = new URLSearchParams();
  parameters.set('projectId', query.projectId);
  if (query.limit !== undefined) parameters.set('limit', String(query.limit));

  const { data } = await client.request<{ decisions: readonly DecisionSummary[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/decisions?${parameters.toString()}`,
  });
  return data.decisions;
}

export interface CreateDecisionInput {
  readonly projectId: string;
  readonly meetingId?: string;
  readonly title: string;
  readonly statement: string;
  readonly status?: DecisionStatus;
  /** An ISO-8601 instant. Optional; the API defaults it to now. */
  readonly decidedAt?: string;
}

export async function createDecision(
  client: ApiClient,
  organizationSlug: string,
  input: CreateDecisionInput,
): Promise<DecisionSummary> {
  const { data } = await client.request<DecisionSummary>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/decisions`,
    body: input,
  });
  return data;
}
