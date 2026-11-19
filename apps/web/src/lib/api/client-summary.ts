import type { ApiClient } from './client';
import type { ProjectHealthBand } from './project-health';
import type {
  SummaryApprovals,
  SummaryDelivery,
  SummaryFiles,
  SummarySignals,
} from './project-summary';

/**
 * ONEPAGE — `GET …/client-organizations/:clientOrganizationId/summary`, the client page's one read
 * (`org.manage`, like the client detail page). Optional blocks are left out when the viewer may not
 * read them; `money` and `unbilled` need the finance capability and their feature. 404 for a
 * company outside the workspace.
 */

export interface ClientSummaryProject {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  /** Absent when the viewer may not read that project's health. */
  readonly band?: ProjectHealthBand;
  /** D7: the health signal that cost the project most; absent with no penalty. */
  readonly reason?: ProjectHealthReason;
}

/** D7: why a project's band is what it is, in facts (the API's `healthReasonOf`). */
export interface ProjectHealthReason {
  readonly kind: 'overdueMilestones' | 'highRisks' | 'openRisks' | 'missedObjectives';
  readonly count: number;
}

/** D7: hours across the client's projects (the project page's Time figures), and per project. */
export interface SummaryClientTime {
  readonly from: string;
  readonly to: string;
  readonly loggedMinutes: number;
  readonly billableMinutes: number;
  /** Projects with logged time, most first. */
  readonly projects: readonly { readonly projectId: string; readonly loggedMinutes: number }[];
}

export interface SummaryCurrencyTotals {
  readonly currency: string;
  readonly invoicedMinor: number;
  readonly paidMinor: number;
  readonly dueMinor: number;
  readonly overdueMinor: number;
  readonly overdueCount: number;
}

export interface SummaryClientMoney {
  readonly totals: readonly SummaryCurrencyTotals[];
  readonly complete: boolean;
}

export interface SummaryUnbilled {
  readonly from: string;
  readonly to: string;
  readonly currency: string | null;
  readonly minutes: number;
  readonly amountMinor: number;
  readonly truncated: boolean;
}

export interface ClientSummary {
  readonly client: {
    readonly id: string;
    readonly name: string;
    readonly archivedAt: string | null;
  };
  readonly projects: {
    readonly items: readonly ClientSummaryProject[];
    /** More projects are shared with the client than the page folds in. */
    readonly truncated: boolean;
  };
  readonly delivery?: SummaryDelivery;
  readonly approvals?: SummaryApprovals;
  readonly files?: SummaryFiles;
  readonly time?: SummaryClientTime;
  readonly money?: SummaryClientMoney;
  readonly unbilled?: SummaryUnbilled;
  readonly signals?: SummarySignals;
}

export async function getClientSummary(
  client: ApiClient,
  organizationSlug: string,
  clientOrganizationId: string,
): Promise<ClientSummary> {
  const { data } = await client.request<ClientSummary>({
    path: `/v1/organizations/${encodeURIComponent(
      organizationSlug,
    )}/client-organizations/${encodeURIComponent(clientOrganizationId)}/summary`,
  });
  return data;
}
