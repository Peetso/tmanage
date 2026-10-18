import type { ApiClient } from './client';

/**
 * The org-wide adoption endpoint — INS-06, the org-level counterpart to INS-05's per-project
 * workload roll-up. Behind `work.read` on the server (the internal-read capability the sibling
 * insights reads reuse); a caller without it gets the ordinary 403 the shared client turns into an
 * error, and an over-wide `days` window gets a 400.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired with the API projection in the
 * `e2e/contracts` shape check so the two shapes cannot drift. The tenant is the slug in the path
 * resolved against the caller's membership, never a value the caller supplies; the counts are
 * tenant-scoped in SQL and re-checked on the server, so this never returns another tenant's numbers.
 */

/** The data gaps the adoption view lists, in display order (mirrors the API's `ADOPTION_GAP_IDS`). */
export type AdoptionGapId =
  'chat_work_untriaged' | 'client_files_internal' | 'requests_uncommitted';

/** One data gap: how many records carry it, across how many projects, and the project when only one. */
export interface InsightsAdoptionGapView {
  readonly id: AdoptionGapId;
  readonly count: number;
  readonly projectCount: number;
  readonly projectName: string | null;
}

/**
 * The adoption and system-quality roll-up. `activeMembers`, `membersWithWork` and `meetingsHeld`
 * are the org-level usage facts; `committedDate` counts work created in the window (and the one
 * before) that carries a committed date; `channels` counts live channels and those no work was ever
 * created from; `unhashedDeliverables` counts deliverables sent for approval whose hash does not
 * match the stored version; `decisionsRecorded` counts decisions logged and approvals decided;
 * `gaps` lists the record gaps. `windowDays` echoes the window the counts were computed over.
 */
export interface InsightsAdoptionView {
  readonly windowDays: number;
  readonly activeMembers: number;
  readonly membersWithWork: number;
  readonly meetingsHeld: number;
  readonly committedDate: {
    readonly dated: number;
    readonly total: number;
    readonly previousDated: number;
    readonly previousTotal: number;
  };
  readonly channels: { readonly total: number; readonly withoutWork: number };
  readonly unhashedDeliverables: { readonly current: number; readonly previous: number };
  readonly decisionsRecorded: { readonly decisionLog: number; readonly approvals: number };
  readonly gaps: readonly InsightsAdoptionGapView[];
  readonly computedAt: string;
}

export async function fetchOrgAdoption(
  client: ApiClient,
  organizationSlug: string,
  options: { days?: number } = {},
): Promise<InsightsAdoptionView> {
  const query = options.days === undefined ? '' : `?days=${encodeURIComponent(options.days)}`;
  const { data } = await client.request<InsightsAdoptionView>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/insights/adoption${query}`,
  });
  return data;
}
