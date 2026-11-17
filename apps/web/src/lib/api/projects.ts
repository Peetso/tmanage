import { projectExportFileName, type ProjectExportFormat } from '@tmanage/domain';
import type { ApiClient } from './client';
import { downloadRecordPdf } from './approval-records';

/**
 * The project and workspace endpoints — PROJ-001, behind `ON-03`.
 *
 * Every path here carries the organization slug, because these are the first **tenant-scoped**
 * endpoints this application calls. The slug is the claim under test: the API's
 * `TenantContextGuard` resolves it against a membership row before any handler runs, and a
 * slug the caller has no membership in produces the same refusal as one that does not exist.
 *
 * So the slug is safe to put in a URL — it is public, it is in every link a customer sends,
 * and holding it grants nothing. That is the opposite of the MFA challenge token, which is
 * deliberately kept out of URLs.
 */

export interface WorkspaceSummary {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

export async function listWorkspaces(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly WorkspaceSummary[]> {
  const { data } = await client.request<{ workspaces: readonly WorkspaceSummary[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/workspaces`,
  });
  return data.workspaces;
}

export interface ProjectSummary {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly status: string;
  readonly ownerUserId: string | null;
  /** A promise, as a `YYYY-MM-DD` calendar date. Set when a milestone plan is confirmed. */
  readonly committedAt: string | null;
  /** An estimate, as a `YYYY-MM-DD` calendar date. This is where `ON-03`'s target date lands. */
  readonly forecastAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

export interface CreateProjectInput {
  readonly workspaceId: string;
  readonly name: string;
  /** `YYYY-MM-DD`. Named `targetDate` because that is what it is until a plan confirms it. */
  readonly targetDate?: string;
  readonly ownerUserId?: string;
}

export async function createProject(
  client: ApiClient,
  organizationSlug: string,
  input: CreateProjectInput,
): Promise<ProjectSummary> {
  const { data } = await client.request<ProjectSummary>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects`,
    body: input,
  });
  return data;
}

export async function getProject(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<ProjectSummary> {
  const { data } = await client.request<ProjectSummary>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}`,
  });
  return data;
}

export async function listProjects(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly ProjectSummary[]> {
  const { data } = await client.request<{ projects: readonly ProjectSummary[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects`,
  });
  return data.projects;
}

/** 54-29 — `GET …/projects/:projectId/export?format=csv|json`, relative to the API origin. */
export function projectExportPath(
  organizationSlug: string,
  projectId: string,
  format: ProjectExportFormat,
): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/export?format=${format}`;
}

/**
 * 54-29 — download one project's export with the session cookie (a `GET`, no CSRF token) and hand
 * it to the browser as a save. `false` when the server refused (403/404/413/429) or the network
 * failed. The bytes are never parsed here, so the JSON `ApiClient` is not involved.
 */
export function downloadProjectExport(
  apiOrigin: string,
  organizationSlug: string,
  project: { readonly id: string; readonly name: string },
  format: ProjectExportFormat,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<boolean> {
  return downloadRecordPdf(
    `${apiOrigin}${projectExportPath(organizationSlug, project.id, format)}`,
    projectExportFileName(project.name, format),
    fetchImpl,
  );
}

/**
 * FIX2 (Peter, 2026-11-09: "New doc" said "That did not work" in a workspace with no project yet).
 * A document and a work item always live in a project, so a one-click "New doc" in a brand-new
 * workspace needs one. This returns the first active project the caller can see, and when there
 * is none, creates a project called `fallbackName` in the first workspace — the caller's own
 * rights still apply: a member who may not create projects gets the API's refusal, not a project.
 * Returns `null` only when the organisation has no workspace at all.
 */
export async function ensureProjectForNewContent(
  client: ApiClient,
  organizationSlug: string,
  fallbackName: string,
): Promise<ProjectSummary | null> {
  const projects = await listProjects(client, organizationSlug);
  const active = projects.find((project) => !project.archivedAt);
  if (active) return active;
  const workspaces = await listWorkspaces(client, organizationSlug);
  const workspace = workspaces[0];
  if (!workspace) return null;
  return createProject(client, organizationSlug, { workspaceId: workspace.id, name: fallbackName });
}
