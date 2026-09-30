import type { ApiClient } from './client';

/**
 * The project timeline-phases endpoints — PROJ / module 8 (x294), all gated on `project.manage`.
 * A project manager groups a project's milestones (x139) into named, ordered phases so the timeline
 * reads as phases.
 *
 * - **Define / list / delete a phase.** `POST …/projects/:id/phases` defines a phase column;
 *   `GET …/projects/:id/phases` lists them in order (each with the ids of the milestones placed in
 *   it); `DELETE …/phases/:phaseId` removes a phase and its assignments.
 * - **Assign a milestone into a phase.** `PUT …/milestones/:milestoneId/phase/:phaseId` places a
 *   milestone into a phase; it is idempotent (re-assigning moves the milestone).
 *
 * Every path is tenant-scoped by the API; an unknown or cross-tenant id is a 404.
 */

export interface ProjectPhaseSummary {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly position: number;
  /** The ids of the milestones placed in this phase. */
  readonly milestoneIds: readonly string[];
}

export interface MilestonePhaseAssignment {
  readonly milestoneId: string;
  readonly phaseId: string;
  readonly projectId: string;
}

export async function listProjectPhases(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<readonly ProjectPhaseSummary[]> {
  const { data } = await client.request<{ phases: readonly ProjectPhaseSummary[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/phases`,
  });
  return data.phases;
}

export interface CreateProjectPhaseInput {
  readonly name: string;
  /** The left-to-right order of the phase column. Optional; the API defaults it to 0. */
  readonly position?: number;
}

export async function createProjectPhase(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  input: CreateProjectPhaseInput,
): Promise<ProjectPhaseSummary> {
  const { data } = await client.request<ProjectPhaseSummary>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/phases`,
    body: input,
  });
  return data;
}

export async function deleteProjectPhase(
  client: ApiClient,
  organizationSlug: string,
  phaseId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/phases/${encodeURIComponent(phaseId)}`,
  });
}

/** Place a milestone into a phase. Idempotent — re-assigning moves the milestone to the new phase. */
export async function assignMilestoneToPhase(
  client: ApiClient,
  organizationSlug: string,
  milestoneId: string,
  phaseId: string,
): Promise<MilestonePhaseAssignment> {
  const { data } = await client.request<MilestonePhaseAssignment>({
    method: 'PUT',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/milestones/${encodeURIComponent(milestoneId)}/phase/${encodeURIComponent(phaseId)}`,
  });
  return data;
}
