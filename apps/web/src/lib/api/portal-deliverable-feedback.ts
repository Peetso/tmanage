import type { ApiClient } from './client';

/**
 * Portal deliverable feedback (module 13 Client Portal, x321) — a client contact's rating (1–5) and
 * optional comment on a *published* deliverable, and the staff read of the feedback left on one.
 *
 * A module of its own, not folded into `portal.ts`, so this slice's files stay disjoint from the
 * sibling portal reads. The client write is behind `client_projection.read` — the one key a client
 * role holds — and the staff read behind `client_member.manage`, which a client can never exercise.
 * The tenant is the slug in the path and the *author* is the authenticated principal, never a value
 * this client supplies. A deliverable that is unpublished, in another studio, or another client's is
 * a 404 the shared client turns into an error — never a signal that the deliverable is real.
 */

/** The client's own view of the feedback they left. No authoring id — it is themselves. */
export interface PortalDeliverableFeedback {
  readonly id: string;
  /** 1–5. */
  readonly rating: number;
  readonly comment: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One feedback as staff read it — the authoring contact is included. */
export interface PortalDeliverableFeedbackStaffEntry {
  readonly id: string;
  readonly clientContactUserId: string;
  readonly rating: number;
  readonly comment: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SubmitPortalDeliverableFeedbackInput {
  /** 1–5. The API refuses anything outside that range with 400. */
  readonly rating: number;
  /** Optional; trimmed and bounded server-side. */
  readonly comment?: string;
}

function path(organizationSlug: string, deliverableId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/portal/deliverables/${encodeURIComponent(
    deliverableId,
  )}/feedback`;
}

/**
 * A client contact leaves or revises their feedback on a published deliverable. `client_projection.read`.
 * A second submit revises the contact's own feedback in place, so this is safe to call again.
 */
export async function submitPortalDeliverableFeedback(
  client: ApiClient,
  organizationSlug: string,
  deliverableId: string,
  input: SubmitPortalDeliverableFeedbackInput,
): Promise<PortalDeliverableFeedback> {
  const { data } = await client.request<PortalDeliverableFeedback>({
    method: 'POST',
    path: path(organizationSlug, deliverableId),
    body: {
      rating: input.rating,
      ...(input.comment !== undefined ? { comment: input.comment } : {}),
    },
  });
  return data;
}

/**
 * The feedback left on a deliverable — staff read, `client_member.manage`. A client caller is
 * refused; a deliverable a caller cannot see is a 404.
 */
export async function listPortalDeliverableFeedback(
  client: ApiClient,
  organizationSlug: string,
  deliverableId: string,
): Promise<readonly PortalDeliverableFeedbackStaffEntry[]> {
  const { data } = await client.request<{
    feedback: readonly PortalDeliverableFeedbackStaffEntry[];
  }>({
    path: path(organizationSlug, deliverableId),
  });
  return data.feedback;
}
