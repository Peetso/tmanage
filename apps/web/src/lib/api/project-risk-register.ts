import type { ApiClient } from './client';

/**
 * The project internal-risk-register endpoints — PROJ / module 8 (x209), gated on `project.manage`
 * (log, update) / `work.read` (list). Nested under a project: every path names the project the risks
 * belong to, tenant-scoped by the API.
 *
 * This is the **internal** register — a formal likelihood×impact matrix with a computed `severity` and
 * a `mitigation` plan. It is distinct from the client-facing portal risks (x140): a different path
 * (`…/projects/:id/risk-register`) and never projected to a client.
 *
 * - **A risk is logged and then worked.** `POST …/projects/:id/risk-register` logs a risk;
 *   `PATCH …/risk-register/:riskId` updates its substance (title, likelihood, impact, mitigation,
 *   status).
 * - **The list is a project's.** `GET …/projects/:id/risk-register` lists one project's risks in
 *   creation order, tenant-scoped by the API.
 */

/** The two axes of the risk matrix. Mirrors the API's likelihood/impact enums. */
export type ProjectInternalRiskLikelihood = 'low' | 'medium' | 'high';
export type ProjectInternalRiskImpact = 'low' | 'medium' | 'high';
/** The computed matrix band. Mirrors the API's `ProjectInternalRiskSeverity`. */
export type ProjectInternalRiskSeverity = 'low' | 'medium' | 'high';
/** Where a risk sits in its lifecycle. Mirrors the API's `ProjectInternalRiskStatus`. */
export type ProjectInternalRiskStatus = 'open' | 'mitigating' | 'mitigated' | 'closed';

export interface ProjectInternalRiskSummary {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly likelihood: ProjectInternalRiskLikelihood;
  readonly impact: ProjectInternalRiskImpact;
  /** Computed by the API from likelihood × impact; not stored. */
  readonly severity: ProjectInternalRiskSeverity;
  readonly mitigation: string | null;
  readonly status: ProjectInternalRiskStatus;
  readonly createdBy: string;
  /** An ISO-8601 instant. */
  readonly createdAt: string;
}

export async function listProjectInternalRisks(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  query: { readonly limit?: number } = {},
): Promise<readonly ProjectInternalRiskSummary[]> {
  const parameters = new URLSearchParams();
  if (query.limit !== undefined) parameters.set('limit', String(query.limit));
  const suffix = parameters.toString() === '' ? '' : `?${parameters.toString()}`;

  const { data } = await client.request<{ risks: readonly ProjectInternalRiskSummary[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/risk-register${suffix}`,
  });
  return data.risks;
}

export interface CreateProjectInternalRiskInput {
  readonly title: string;
  readonly likelihood: ProjectInternalRiskLikelihood;
  readonly impact: ProjectInternalRiskImpact;
  readonly mitigation?: string;
  /** Optional; the API defaults it to `open`. */
  readonly status?: ProjectInternalRiskStatus;
}

export async function createProjectInternalRisk(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  input: CreateProjectInternalRiskInput,
): Promise<ProjectInternalRiskSummary> {
  const { data } = await client.request<ProjectInternalRiskSummary>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/risk-register`,
    body: input,
  });
  return data;
}

export interface UpdateProjectInternalRiskInput {
  readonly title?: string;
  readonly likelihood?: ProjectInternalRiskLikelihood;
  readonly impact?: ProjectInternalRiskImpact;
  readonly mitigation?: string | null;
  readonly status?: ProjectInternalRiskStatus;
}

/** Update a risk's substance. At least one field must be provided. */
export async function updateProjectInternalRisk(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  riskId: string,
  input: UpdateProjectInternalRiskInput,
): Promise<ProjectInternalRiskSummary> {
  const { data } = await client.request<ProjectInternalRiskSummary>({
    method: 'PATCH',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/risk-register/${encodeURIComponent(riskId)}`,
    body: input,
  });
  return data;
}
