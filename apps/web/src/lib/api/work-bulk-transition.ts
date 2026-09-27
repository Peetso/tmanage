import type { WorkItemState } from '@tmanage/domain';
import type { ApiClient } from './client';

/**
 * x206 — the work bulk status transition (Work module 7).
 *
 * The single-item transition lives in `work-items.ts`; this is its multi-select sibling. One
 * request names a set of ids and a target state, and the answer is a per-id outcome rather than
 * one moved row — the batch is deliberately *not* all-or-nothing, so the caller learns which
 * items moved and why the rest did not.
 *
 * The response shape here is paired `Exact` with the API's `BulkTransitionView` in
 * `e2e/contracts`. The per-id result interface is intentionally not exported: it is compared
 * structurally through `BulkTransitionView` and adds no second shape for the contracts check to
 * pair.
 */

/** What became of one id — mirrors the API's `BulkTransitionOutcome`. */
export type BulkTransitionOutcome =
  'applied' | 'not_found' | 'forbidden' | 'skipped_invalid' | 'conflict';

interface BulkTransitionItemResult {
  readonly id: string;
  readonly outcome: BulkTransitionOutcome;
  readonly reason: string | null;
}

export interface BulkTransitionView {
  readonly targetStatus: WorkItemState;
  readonly results: readonly BulkTransitionItemResult[];
  readonly appliedCount: number;
}

export interface BulkTransitionInput {
  readonly ids: readonly string[];
  readonly targetStatus: WorkItemState;
}

export async function bulkTransitionWorkItems(
  client: ApiClient,
  organizationSlug: string,
  input: BulkTransitionInput,
): Promise<BulkTransitionView> {
  const { data } = await client.request<BulkTransitionView>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-items/bulk-transition`,
    body: input,
  });
  return data;
}
