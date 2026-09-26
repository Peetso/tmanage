import type { ApiClient } from './client';

/**
 * The project-portfolio endpoint — PROJ / module 8 (x137), gated on `work.read`. A read-only roll-up
 * across the projects the caller can see: one summary row per project, tenant- and relation-scoped by
 * the API.
 *
 * - **`GET …/projects/portfolio`** returns a bounded, deterministic page of project summaries.
 * - Each row folds the project's open-work count, its x124 objective tallies by status, and when work
 *   last moved. It is not a health score — no grade, RAG model, or percentage — those are deferred.
 */

export interface ProjectPortfolioSummary {
  readonly projectId: string;
  readonly name: string;
  readonly status: string;
  /** Non-deleted work items that are neither done nor archived. */
  readonly openWorkCount: number;
  /** Objective tallies by lifecycle status. A status with none is `0`, never absent. */
  readonly objectiveCounts: {
    readonly open: number;
    readonly met: number;
    readonly missed: number;
  };
  /** An ISO-8601 instant, or `null` for a project with no activity yet. */
  readonly latestActivityAt: string | null;
}

export async function listProjectPortfolio(
  client: ApiClient,
  organizationSlug: string,
  query: { readonly limit?: number } = {},
): Promise<readonly ProjectPortfolioSummary[]> {
  const parameters = new URLSearchParams();
  if (query.limit !== undefined) parameters.set('limit', String(query.limit));
  const suffix = parameters.toString() === '' ? '' : `?${parameters.toString()}`;

  const { data } = await client.request<{ projects: readonly ProjectPortfolioSummary[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/portfolio${suffix}`,
  });
  return data.projects;
}
