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

/**
 * DEC-02 (x117). A decision's detail plus its supersede chain: the decision that superseded it
 * (`supersededBy`, at most one) and the decisions it superseded (`supersedes`). Mirrors the API's
 * `DecisionDetailView`, returned by `GET …/decisions/:id` and `POST …/decisions/:id/supersede`.
 *
 * The edge shape (`{ decisionId, at }`) is inline and unexported on purpose: a named exported edge
 * type would be enumerated by `contracts:check` as its own web response projection needing a pair,
 * and it is not one — it is a member of this detail.
 */
export interface DecisionDetail extends DecisionSummary {
  readonly supersededBy: { readonly decisionId: string; readonly at: string } | null;
  readonly supersedes: readonly { readonly decisionId: string; readonly at: string }[];
}

export async function getDecision(
  client: ApiClient,
  organizationSlug: string,
  decisionId: string,
): Promise<DecisionDetail> {
  const { data } = await client.request<DecisionDetail>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/decisions/${encodeURIComponent(decisionId)}`,
  });
  return data;
}

/** DEC-01-b (x117). Accept a decision: `proposed → accepted`. */
export async function acceptDecision(
  client: ApiClient,
  organizationSlug: string,
  decisionId: string,
): Promise<DecisionSummary> {
  const { data } = await client.request<DecisionSummary>({
    method: 'PATCH',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/decisions/${encodeURIComponent(decisionId)}`,
    body: { status: 'accepted' },
  });
  return data;
}

/**
 * SEC / Decisions (x150). A decision lock — the durable fact that a decision has been sealed against
 * further lifecycle writes: by whom (`lockedBy`) and when (`lockedAt`). Mirrors the API's
 * `DecisionLockView`, returned by `POST …/decisions/:id/lock`. `organizationId` is never on the wire.
 */
export interface DecisionLock {
  readonly id: string;
  readonly decisionId: string;
  readonly lockedBy: string;
  /** An ISO-8601 instant. */
  readonly lockedAt: string;
}

/**
 * SEC / Decisions (x150). Lock a decision. Gated on the server by `meeting.write`; a decision already
 * locked is a 409, and a locked decision refuses every later accept/supersede. There is no unlock this
 * slice.
 */
export async function lockDecision(
  client: ApiClient,
  organizationSlug: string,
  decisionId: string,
): Promise<DecisionLock> {
  const { data } = await client.request<DecisionLock>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/decisions/${encodeURIComponent(decisionId)}/lock`,
  });
  return data;
}

/** DEC-01-b / DEC-02 (x117). Supersede a decision by another decision. */
export async function supersedeDecision(
  client: ApiClient,
  organizationSlug: string,
  decisionId: string,
  supersededById: string,
): Promise<DecisionDetail> {
  const { data } = await client.request<DecisionDetail>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/decisions/${encodeURIComponent(decisionId)}/supersede`,
    body: { supersededById },
  });
  return data;
}
