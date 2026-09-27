import type { ApiClient } from './client';

/**
 * The project-health endpoints — PROJ / module 8 (x208), gated on `work.read`. A read-only computed
 * health roll-up derived from the signals already stored against a project.
 *
 * - **`GET …/projects/health`** returns the band for every project the caller can see.
 * - **`GET …/projects/:projectId/health`** returns one project's health, or 404 if the caller may not
 *   see it (a foreign or unrelated project is indistinguishable from a missing one).
 *
 * Unlike the portfolio (x137), which shows counts and no score, this endpoint bands each project
 * green/amber/red from overdue milestones, open risks and missed objectives. The weights and
 * thresholds are fixed on the server — the client sends no scoring input and cannot move a band — and
 * a project with no signals at all is reported as `neutral`, not a false green.
 */

export type ProjectHealthBand = 'green' | 'amber' | 'red' | 'neutral';

export interface ProjectHealthSummary {
  readonly projectId: string;
  readonly name: string;
  readonly status: string;
  /** 0..100; the ceiling for a project with no penalties (including an empty project). */
  readonly score: number;
  /** `neutral` when the project has no health signals at all; otherwise the banded score. */
  readonly band: ProjectHealthBand;
  /** The signal counts the band was derived from — each independently checkable on the project. */
  readonly signals: {
    readonly overdueMilestones: number;
    readonly openRisks: number;
    readonly highRisks: number;
    readonly objectivesTotal: number;
    readonly objectivesMet: number;
    readonly objectivesMissed: number;
  };
}

export async function listProjectHealth(
  client: ApiClient,
  organizationSlug: string,
  query: { readonly limit?: number } = {},
): Promise<readonly ProjectHealthSummary[]> {
  const parameters = new URLSearchParams();
  if (query.limit !== undefined) parameters.set('limit', String(query.limit));
  const suffix = parameters.toString() === '' ? '' : `?${parameters.toString()}`;

  const { data } = await client.request<{ projects: readonly ProjectHealthSummary[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/health${suffix}`,
  });
  return data.projects;
}

export async function getProjectHealth(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<ProjectHealthSummary> {
  const { data } = await client.request<ProjectHealthSummary>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(
      projectId,
    )}/health`,
  });
  return data;
}
