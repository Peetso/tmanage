import type { ApiClient } from './client';

/**
 * The project retrospective-notes endpoints — PROJ / module 8 (x311), gated on `project.manage`
 * (capture, list, delete). Nested under a project: every path names the project the notes belong to,
 * tenant-scoped by the API.
 *
 * A retro note is a **categorised reflection** captured during a retrospective — filed under
 * `went_well` / `to_improve` / `action`, with a free-text `body` and an optional milestone reference.
 * Distinct from the status-band changelog (x235) and from client-facing portal updates (x125).
 *
 * - **A note is captured.** `POST …/projects/:id/retro-notes` (category + body, optional milestoneId).
 * - **The board is a project's.** `GET …/projects/:id/retro-notes` lists one project's notes grouped
 *   by category, each group newest-first, tenant-scoped by the API.
 * - **A note is removed.** `DELETE …/projects/:id/retro-notes/:noteId` (idempotent, 204).
 */

/** The retrospective category a note is filed under. Mirrors the API's `category` enum. */
export type ProjectRetroNoteCategory = 'went_well' | 'to_improve' | 'action';

export interface ProjectRetroNoteSummary {
  readonly id: string;
  readonly projectId: string;
  readonly milestoneId: string | null;
  readonly category: ProjectRetroNoteCategory;
  readonly body: string;
  readonly createdBy: string;
  /** An ISO-8601 instant. */
  readonly createdAt: string;
}

/** The retro board, mirroring the API's grouped projection. */
export interface ProjectRetroBoard {
  readonly wentWell: readonly ProjectRetroNoteSummary[];
  readonly toImprove: readonly ProjectRetroNoteSummary[];
  readonly action: readonly ProjectRetroNoteSummary[];
}

export async function listProjectRetroNotes(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<ProjectRetroBoard> {
  const { data } = await client.request<ProjectRetroBoard>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/retro-notes`,
  });
  return data;
}

export interface CreateProjectRetroNoteInput {
  readonly category: ProjectRetroNoteCategory;
  readonly body: string;
  readonly milestoneId?: string | null;
}

export async function createProjectRetroNote(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  input: CreateProjectRetroNoteInput,
): Promise<ProjectRetroNoteSummary> {
  const { data } = await client.request<ProjectRetroNoteSummary>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/retro-notes`,
    body: input,
  });
  return data;
}

export async function deleteProjectRetroNote(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  noteId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/retro-notes/${encodeURIComponent(noteId)}`,
  });
}
