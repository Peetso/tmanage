import type { ApiClient } from './client';
import type { ProjectSummary } from './projects';

/**
 * The project-templates endpoints — PROJ / module 8 (x234), gated on `project.manage`. Org-scoped:
 * every path is `…/organizations/:orgSlug/projects/templates`, tenant-scoped by the API, with no
 * project in it.
 *
 * - **A template is defined and instantiated.** `POST …/projects/templates` defines a reusable
 *   template (a name, an optional description, and the default objective titles a project made from it
 *   should start with); `POST …/projects/templates/:id/instantiate` creates a project from it through
 *   the shared project-create path, returning an ordinary project.
 * - **The list is the organization's.** `GET …/projects/templates` lists the tenant's templates in
 *   creation order.
 */

export interface ProjectTemplateView {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  /** The objective titles a project made from this template starts with; `[]` when none declared. */
  readonly defaultObjectives: readonly string[];
  /** A9. How many milestones a project made from it starts with. */
  readonly milestoneCount: number;
  /** A9. How many work items a project made from it starts with. */
  readonly workItemCount: number;
  /** A9. Whether a project made from it is shared with the chosen client. */
  readonly clientPortalOn: boolean;
  /** A9. `monthly` for a retainer; null for a one-off project. */
  readonly repeatInterval: 'monthly' | null;
  readonly createdBy: string;
  /** An ISO-8601 instant. */
  readonly createdAt: string;
}

export async function listProjectTemplates(
  client: ApiClient,
  organizationSlug: string,
  query: { readonly limit?: number } = {},
): Promise<readonly ProjectTemplateView[]> {
  const parameters = new URLSearchParams();
  if (query.limit !== undefined) parameters.set('limit', String(query.limit));
  const suffix = parameters.toString() === '' ? '' : `?${parameters.toString()}`;

  const { data } = await client.request<{ templates: readonly ProjectTemplateView[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/templates${suffix}`,
  });
  return data.templates;
}

export interface CreateProjectTemplateInput {
  readonly name: string;
  readonly description?: string;
  readonly defaultObjectives?: readonly string[];
}

export async function createProjectTemplate(
  client: ApiClient,
  organizationSlug: string,
  input: CreateProjectTemplateInput,
): Promise<ProjectTemplateView> {
  const { data } = await client.request<ProjectTemplateView>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/templates`,
    body: input,
  });
  return data;
}

export interface InstantiateProjectTemplateInput {
  readonly workspaceId: string;
  /** Optional; without one the project takes the template's name. */
  readonly name?: string;
  /** A9. 'YYYY-MM-DD'; every template date moves to it. Today when absent. */
  readonly startDate?: string;
  /** A9. The client company the new project is shared with. */
  readonly clientOrganizationId?: string;
  /** A9. The project lead (owner, and manager on the project). */
  readonly leadUserId?: string;
}

/** Create a project from a template. Returns the newly created project. */
export async function instantiateProjectTemplate(
  client: ApiClient,
  organizationSlug: string,
  templateId: string,
  input: InstantiateProjectTemplateInput,
): Promise<ProjectSummary> {
  const { data } = await client.request<ProjectSummary>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/templates/${encodeURIComponent(templateId)}/instantiate`,
    body: input,
  });
  return data;
}
