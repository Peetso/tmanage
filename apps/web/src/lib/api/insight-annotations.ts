import type { ApiClient } from './client';

/**
 * The insight-annotation endpoints — x271, module 15 (Insights & reporting). An explanatory note
 * attached to an insight snapshot so a frozen figure carries the context that explains it (INS-01
 * "every score is explainable"). Behind `work.read` on the server (the internal-read capability the
 * sibling insights reads reuse); a caller without it gets the ordinary 403 the shared client turns
 * into an error, a note that is empty or over-long gets a 400, an unknown snapshot gets a 404, and
 * deleting another author's note gets a 403.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired with the API projection in the
 * `e2e/contracts` shape check so the two shapes cannot drift. The tenant is the slug in the path
 * resolved against the caller's membership, and the author is always the authenticated principal —
 * never a value this client supplies.
 */

/**
 * One annotation on a snapshot — paired Exact with the API's `InsightAnnotationView`.
 * `organizationId`/`snapshotId` are absent on both sides (the wire projection never echoes the tenant
 * id, and the snapshot is the one named in the path). `authorMembershipId` lets the screen mark the
 * caller's own notes — those that carry a delete affordance.
 */
export interface InsightAnnotationView {
  readonly id: string;
  readonly authorMembershipId: string;
  readonly note: string;
  /** ISO-8601 instant. */
  readonly createdAt: string;
}

function base(organizationSlug: string, snapshotId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/insights/snapshots/${encodeURIComponent(snapshotId)}/annotations`;
}

/** List one snapshot's annotations, newest first. An unknown snapshot is a 404. */
export async function listInsightAnnotations(
  client: ApiClient,
  organizationSlug: string,
  snapshotId: string,
): Promise<readonly InsightAnnotationView[]> {
  const { data } = await client.request<{ annotations: readonly InsightAnnotationView[] }>({
    path: base(organizationSlug, snapshotId),
  });
  return data.annotations;
}

/** Attach a note to a snapshot, authored by the caller. Empty/over-long note is a 400. */
export async function addInsightAnnotation(
  client: ApiClient,
  organizationSlug: string,
  snapshotId: string,
  note: string,
): Promise<InsightAnnotationView> {
  const { data } = await client.request<InsightAnnotationView>({
    method: 'POST',
    path: base(organizationSlug, snapshotId),
    body: { note },
  });
  return data;
}

/** Delete one of the caller's own annotations. Another author's note is a 403. */
export async function deleteInsightAnnotation(
  client: ApiClient,
  organizationSlug: string,
  snapshotId: string,
  annotationId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${base(organizationSlug, snapshotId)}/${encodeURIComponent(annotationId)}`,
  });
}
