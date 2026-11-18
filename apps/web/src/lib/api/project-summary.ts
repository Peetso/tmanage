import type { ApiClient } from './client';
import type { ProjectHealthBand } from './project-health';

/**
 * ONEPAGE — `GET …/projects/:projectId/summary`, the project page's one read (`work.read`).
 *
 * Every block except `project` is optional: the server leaves out a block the viewer may not read
 * (no capability, the source's feature off, or the source refusing), so a missing key means "not
 * yours to see" and the screen shows no block, while a present block with zeros means "nothing
 * there". `money` needs the finance capability. 404 for a project the caller cannot see.
 */

export interface SummaryDelivery {
  readonly open: number;
  readonly late: number;
  readonly done: number;
  /** False when the project has more work than one summary walks; the full screen has it all. */
  readonly complete: boolean;
}

export interface SummaryMilestone {
  readonly next: {
    readonly id: string;
    readonly title: string;
    readonly dueOn: string | null;
  } | null;
  readonly planned: number;
  readonly missed: number;
}

export interface SummaryHealth {
  readonly band: ProjectHealthBand;
  readonly score: number;
  readonly overdueMilestones: number;
  readonly openRisks: number;
  readonly highRisks: number;
}

export type SummaryWaitingOn = 'team' | 'client';

export interface SummaryWaitingApproval {
  readonly deliverableId: string;
  readonly projectId: string;
  readonly title: string;
  readonly waitingOn: SummaryWaitingOn;
  readonly since: string;
}

export interface SummaryApprovals {
  readonly waitingOnTeam: number;
  readonly waitingOnClient: number;
  /** Oldest first, at most five. */
  readonly items: readonly SummaryWaitingApproval[];
}

export interface SummaryFile {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly mimeType: string | null;
  readonly updatedAt: string;
}

export interface SummaryFiles {
  /** Newest first, at most five. */
  readonly items: readonly SummaryFile[];
}

export interface SummaryTime {
  readonly from: string;
  readonly to: string;
  readonly loggedMinutes: number;
  readonly billableMinutes: number;
}

export interface SummaryBudget {
  readonly budgetHours: number | null;
  readonly trackedHours: number;
  readonly remainingHours: number | null;
  readonly percentBp: number | null;
  readonly status: string | null;
}

export interface SummaryProjectMoney {
  readonly from: string;
  readonly to: string;
  readonly currency: string | null;
  readonly invoicedMinor: number;
  readonly unbilledMinor: number;
  readonly unbilledMinutes: number;
  readonly truncated: boolean;
}

export interface ProjectSummary {
  readonly project: {
    readonly id: string;
    readonly name: string;
    readonly status: string;
    readonly committedAt: string | null;
    readonly forecastAt: string | null;
    readonly archivedAt: string | null;
  };
  readonly delivery?: SummaryDelivery;
  readonly milestone?: SummaryMilestone;
  readonly health?: SummaryHealth;
  readonly approvals?: SummaryApprovals;
  readonly files?: SummaryFiles;
  readonly time?: SummaryTime;
  readonly budget?: SummaryBudget;
  readonly money?: SummaryProjectMoney;
}

export async function getProjectSummary(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<ProjectSummary> {
  const { data } = await client.request<ProjectSummary>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(
      projectId,
    )}/summary`,
  });
  return data;
}
