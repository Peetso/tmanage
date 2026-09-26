import type { WorkItemState } from '@tmanage/domain';
import type { ApiClient } from './client';

/**
 * The project delivery-flow endpoint — INS-01, the delivery-flow counterpart to INS-02's approval
 * cycle. Behind `work.read` on the server (the internal-read capability x86 reuses); a caller
 * without it gets the ordinary 403 the shared client turns into an error.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired with the API projection in
 * the `e2e/contracts` shape check so the two shapes cannot drift. The tenant is the slug in the
 * path resolved against the caller's membership, never a value the caller supplies; the project
 * is the id on the route. A cross-tenant or unknown project id returns an empty roll-up (every
 * count zero), never another tenant's numbers and never a 500 — the read is tenant-scoped in SQL
 * and re-checked per row on the server.
 */

/**
 * A project's delivery flow — its work items tallied by workflow status. `counts` carries every
 * lifecycle status (`backlog … archived`), zero when none; `itemCount` is their sum, which lets a
 * reader tell an empty project (every count zero) from one it simply may not read into. Computed
 * on demand, never stored.
 */
export interface DeliveryFlow {
  readonly projectId: string;
  readonly counts: Record<WorkItemState, number>;
  readonly itemCount: number;
  readonly computedAt: string;
}

export async function fetchProjectDeliveryFlow(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<DeliveryFlow> {
  const { data } = await client.request<DeliveryFlow>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/insights/projects/${encodeURIComponent(
      projectId,
    )}/delivery-flow`,
  });
  return data;
}
