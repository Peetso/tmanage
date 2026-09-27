import type { ApiClient } from './client';

/**
 * The insight-snapshots endpoints — x211, module 15 (Insights & reporting). A snapshot freezes an
 * org-level insights read so the studio can compare today's numbers against a stored moment over
 * time. Behind `work.read` on the server (the internal-read capability the sibling insights reads
 * reuse); a caller without it gets the ordinary 403 the shared client turns into an error, an unknown
 * `kind` gets a 400, and a snapshot from another tenant gets a 404.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired with the API projection in the
 * `e2e/contracts` shape check so the two shapes cannot drift. The tenant is the slug in the path
 * resolved against the caller's membership, never a value the caller supplies.
 */

/** The report kinds a snapshot can freeze — mirrors the API's closed vocabulary. */
export type SnapshotKind = 'portfolio' | 'workload';

/**
 * One stored snapshot. `payload` is the computed metrics the read returned, kept opaque (`unknown`)
 * at the boundary — the screen renders it as the metric it captured. `capturedAt` is the ISO instant
 * the metrics were computed.
 */
export interface SnapshotView {
  readonly id: string;
  readonly kind: SnapshotKind;
  readonly capturedAt: string;
  readonly payload: unknown;
}

/** Capture the current metrics for a kind into a new stored snapshot. */
export async function captureSnapshot(
  client: ApiClient,
  organizationSlug: string,
  kind: SnapshotKind,
): Promise<SnapshotView> {
  const { data } = await client.request<SnapshotView>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/insights/snapshots`,
    body: { kind },
  });
  return data;
}

/** List the tenant's snapshots of one kind, newest first, in a clamped page. */
export async function listSnapshots(
  client: ApiClient,
  organizationSlug: string,
  kind: SnapshotKind,
): Promise<readonly SnapshotView[]> {
  const { data } = await client.request<readonly SnapshotView[]>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/insights/snapshots?kind=${encodeURIComponent(kind)}`,
  });
  return data;
}

/** Fetch one snapshot by id — the compare surface's read. A cross-tenant or missing id is a 404. */
export async function fetchSnapshot(
  client: ApiClient,
  organizationSlug: string,
  snapshotId: string,
): Promise<SnapshotView> {
  const { data } = await client.request<SnapshotView>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/insights/snapshots/${encodeURIComponent(snapshotId)}`,
  });
  return data;
}
