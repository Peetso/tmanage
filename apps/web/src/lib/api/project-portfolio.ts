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
  /** POR-01 COMMITTED: the recorded commitment, else the earliest planned milestone (`YYYY-MM-DD`). */
  readonly committedOn: string | null;
  /** POR-01 FORECAST: the recorded forecast date (`YYYY-MM-DD`), or `null`. */
  readonly forecastOn: string | null;
  readonly clientName: string | null;
  readonly ownerName: string | null;
  /** POR-01 CLIENT WAIT: when the oldest still-pending approval was requested (ISO instant). */
  readonly clientWaitSince: string | null;
  /** The project's creation day (`YYYY-MM-DD`) — where its timeline bar starts. */
  readonly startedOn: string;
  readonly archivedAt: string | null;
  /** Milestones in due order, for the POR-02 timeline. */
  readonly milestones: readonly PortfolioMilestone[];
}

export interface PortfolioMilestone {
  readonly title: string;
  readonly dueOn: string | null;
  readonly status: 'planned' | 'met' | 'missed';
  /** Published to the client portal — a client-facing date. */
  readonly published: boolean;
}

/** POR-03 — `GET …/projects/portfolio/capacity`, gated on `work.read`. */
export interface PortfolioCapacity {
  /** The Monday the week starts (`YYYY-MM-DD`). */
  readonly weekStart: string;
  readonly disciplines: readonly {
    /** `null` for members with no department set. */
    readonly discipline: string | null;
    readonly members: number;
    readonly capacityHours: number;
    readonly allocatedHours: number;
    readonly loadPercent: number;
  }[];
  readonly unstaffed: {
    readonly total: number;
    readonly items: readonly {
      readonly workItemId: string;
      readonly title: string;
      readonly projectId: string;
      readonly projectName: string;
      readonly dueOn: string | null;
    }[];
  };
  readonly constraint: {
    readonly discipline: string | null;
    readonly loadPercent: number;
    readonly internalDatesThisWeek: number;
  } | null;
}

export async function getPortfolioCapacity(
  client: ApiClient,
  organizationSlug: string,
  query: { readonly week?: string } = {},
): Promise<PortfolioCapacity> {
  const suffix = query.week === undefined ? '' : `?week=${encodeURIComponent(query.week)}`;
  const { data } = await client.request<PortfolioCapacity>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/portfolio/capacity${suffix}`,
  });
  return data;
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
