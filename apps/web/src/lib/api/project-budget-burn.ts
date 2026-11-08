import type { ApiClient } from './client';

/**
 * 52-05 — `GET …/projects/:projectId/budget/burn`: the logged time grouped by week (Monday,
 * `YYYY-MM-DD`) over `from..to` (default the last 12 weeks). Gate `work.read` with a project
 * relation; `amountMinor` only reaches a caller holding `finance.view`.
 */

export interface BurnBucket {
  readonly key: string;
  readonly minutes: number;
  readonly billableMinutes: number;
  readonly unpricedMinutes: number;
  readonly amountMinor?: number;
}

export interface BurnReport {
  readonly projectId: string;
  readonly from: string;
  readonly to: string;
  readonly groupBy: 'week' | 'person';
  readonly buckets: readonly BurnBucket[];
  readonly nextCursor: string | null;
  /** At the range's average weekly pace, the day the hours budget runs out (null: no budget/pace). */
  readonly forecastExhaustedOn: string | null;
}

export async function getBudgetBurn(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<BurnReport> {
  const { data } = await client.request<BurnReport>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/budget/burn?groupBy=week`,
  });
  return data;
}
