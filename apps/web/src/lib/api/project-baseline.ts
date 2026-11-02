import type { ApiClient } from './client';

/**
 * The project milestone-plan baseline endpoints — PROJ / module 8 (x295), gated on `project.manage`.
 * Nested under a project: every path names the project the baselines belong to, tenant-scoped by the
 * API.
 *
 * - **A baseline is frozen, then read.** `POST …/projects/:id/baselines` snapshots the current
 *   milestone plan under a `label`; the snapshot is immutable.
 * - **The list is a project's.** `GET …/projects/:id/baselines` lists one project's baselines, newest
 *   first.
 * - **Variance is recomputed at read time.** `GET …/projects/:id/baselines/:baselineId/variance`
 *   returns today's milestone dates against the frozen plan (slippage in days).
 * - **A superseded baseline may be discarded.** `DELETE …/projects/:id/baselines/:baselineId`.
 */

export interface ProjectBaselineSummary {
  readonly id: string;
  readonly projectId: string;
  readonly label: string;
  /** 53-05: an internal note, or null. */
  readonly note: string | null;
  /** 53-05: 'milestones' (the milestone plan only) or 'full' (every work item frozen too). */
  readonly kind: 'milestones' | 'full';
  /** 53-05: whether this is the project's current baseline (the timeline overlay). */
  readonly isCurrent: boolean;
  /** How many milestones were frozen into this baseline. */
  readonly milestoneCount: number;
  /** 53-05: how many work items were frozen into this baseline (0 for a milestone-only one). */
  readonly itemCount: number;
  readonly createdBy: string;
  /** An ISO-8601 instant. */
  readonly createdAt: string;
}

export interface ProjectBaselineVarianceRow {
  readonly milestoneId: string;
  /** The milestone's current title, or null when frozen in the baseline but since removed. */
  readonly title: string | null;
  /** The date frozen in the baseline (`YYYY-MM-DD`), or null. */
  readonly baselineDate: string | null;
  /** The milestone's current target date (`YYYY-MM-DD`), or null. */
  readonly currentDate: string | null;
  /** `currentDate - baselineDate` in whole days (positive = slipped later); null when either absent. */
  readonly deltaDays: number | null;
}

/** 53-05: one work item's variance against the baseline (dates are `YYYY-MM-DD`). */
export interface ProjectBaselineItemVariance {
  readonly workItemId: string;
  /** The live title when the caller may read the item; null otherwise or when removed. */
  readonly title: string | null;
  readonly baselineStart: string | null;
  readonly baselineDue: string | null;
  readonly currentStart: string | null;
  readonly currentDue: string | null;
  /** Working days of slip (positive = later); null when either side has no date. */
  readonly deltaWorkingDays: number | null;
  readonly status: 'slipped' | 'early' | 'on_track' | 'removed' | 'added';
}

export interface ProjectBaselineVarianceSummary {
  readonly slipped: number;
  readonly early: number;
  readonly onTrack: number;
  readonly removed: number;
  readonly added: number;
  readonly maxSlipDays: number;
}

export interface ProjectBaselineVariance {
  readonly baselineId: string;
  readonly label: string;
  readonly createdAt: string;
  /** 53-05: the other baseline compared against, or null when compared to the live plan. */
  readonly againstBaselineId: string | null;
  readonly rows: readonly ProjectBaselineVarianceRow[];
  readonly items: readonly ProjectBaselineItemVariance[];
  readonly summary: ProjectBaselineVarianceSummary;
  readonly nextCursor: string | null;
}

export async function listProjectBaselines(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  query: { readonly limit?: number } = {},
): Promise<readonly ProjectBaselineSummary[]> {
  const parameters = new URLSearchParams();
  if (query.limit !== undefined) parameters.set('limit', String(query.limit));
  const suffix = parameters.toString() === '' ? '' : `?${parameters.toString()}`;

  const { data } = await client.request<{ baselines: readonly ProjectBaselineSummary[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/baselines${suffix}`,
  });
  return data.baselines;
}

export async function createProjectBaseline(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  input: { readonly label: string },
): Promise<ProjectBaselineSummary> {
  const { data } = await client.request<ProjectBaselineSummary>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/baselines`,
    body: input,
  });
  return data;
}

export async function getProjectBaselineVariance(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  baselineId: string,
): Promise<ProjectBaselineVariance> {
  const { data } = await client.request<ProjectBaselineVariance>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/baselines/${encodeURIComponent(baselineId)}/variance`,
  });
  return data;
}

export async function deleteProjectBaseline(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  baselineId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/baselines/${encodeURIComponent(baselineId)}`,
  });
}
