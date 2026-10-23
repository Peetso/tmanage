import type { ApiClient } from './client';

/**
 * A9 — the project Milestones list and Edit milestone (Figma `fq6-milestones`,
 * `fq6-edit-milestone`). Internal only, behind `project.manage`, on the `projects` path:
 *
 * - `GET …/projects/:projectId/milestone-plan` — every milestone with what it delivers and its
 *   owner, plus the name of the client company that sees the published ones;
 * - `POST …/projects/:projectId/milestones` — "Add milestone";
 * - `PATCH …/projects/:projectId/milestones/:id` — name, due date, what is delivered, owner and
 *   "Show on the client timeline";
 * - `DELETE …/projects/:projectId/milestones/:id` — refused (409) while anything links to it.
 *
 * Hand-written and paired with the API views in the `e2e/contracts` shape check.
 */

/** Paired Exact with the API `MilestoneDetailView`. */
export interface MilestoneDetail {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly description: string | null;
  /** 'YYYY-MM-DD', or null when no date is committed. */
  readonly dueOn: string | null;
  readonly status: 'planned' | 'met' | 'missed';
  /** "Show on the client timeline". */
  readonly published: boolean;
  readonly ownerUserId: string | null;
  /** ISO-8601; for a met milestone, when it was marked done. */
  readonly updatedAt: string;
}

/** Paired Exact with the API `MilestonePlanView`. */
export interface MilestonePlan {
  readonly clientName: string | null;
  readonly milestones: readonly MilestoneDetail[];
}

export interface MilestoneEditInput {
  readonly title?: string;
  readonly dueOn?: string | null;
  readonly description?: string | null;
  readonly ownerUserId?: string | null;
  readonly published?: boolean;
}

export interface MilestoneCreateInput {
  readonly title: string;
  readonly dueOn: string | null;
  readonly published: boolean;
}

function milestonesPath(organizationSlug: string, projectId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}`;
}

export async function getMilestonePlan(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<MilestonePlan> {
  const { data } = await client.request<MilestonePlan>({
    path: `${milestonesPath(organizationSlug, projectId)}/milestone-plan`,
  });
  return data;
}

/** "Add milestone". Returns the new milestone's id. */
export async function createMilestone(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  input: MilestoneCreateInput,
): Promise<string> {
  const { data } = await client.request<{ readonly id: string }>({
    method: 'POST',
    path: `${milestonesPath(organizationSlug, projectId)}/milestones`,
    body: { ...input, status: 'planned' },
  });
  return data.id;
}

export async function editMilestone(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  milestoneId: string,
  input: MilestoneEditInput,
): Promise<void> {
  await client.request({
    method: 'PATCH',
    path: `${milestonesPath(organizationSlug, projectId)}/milestones/${encodeURIComponent(milestoneId)}`,
    body: input,
  });
}

export async function deleteMilestone(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  milestoneId: string,
): Promise<void> {
  await client.request({
    method: 'DELETE',
    path: `${milestonesPath(organizationSlug, projectId)}/milestones/${encodeURIComponent(milestoneId)}`,
  });
}

/** The state pill a row shows: met is Done, the first open milestone is In progress, the rest Next. */
export type MilestoneStage = 'done' | 'inProgress' | 'next';

export function milestoneStages(milestones: readonly MilestoneDetail[]): readonly MilestoneStage[] {
  let current = false;
  return milestones.map((milestone) => {
    if (milestone.status === 'met') return 'done';
    if (!current) {
      current = true;
      return 'inProgress';
    }
    return 'next';
  });
}
