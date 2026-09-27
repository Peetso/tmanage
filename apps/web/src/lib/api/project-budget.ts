import type { ApiClient } from './client';

/**
 * The project-budget endpoints — PROJ / project detail (x293), gated on `project.manage`. Nested
 * under a project: every path names the project the budget belongs to, tenant-scoped by the API.
 *
 * A project has at most one budget row. `GET …/projects/:id/budget` reads the budget-vs-tracked
 * summary (the planned figures plus the effort already logged on the project's work items);
 * `PUT …/projects/:id/budget` sets or replaces it. The amount is a planning number, never a payment.
 */

export interface ProjectBudgetSummary {
  readonly projectId: string;
  /** Planned effort in hours, or null when only an amount (or nothing) is budgeted. */
  readonly budgetHours: number | null;
  /** Planned amount in minor units (e.g. cents), or null when only effort (or nothing) is budgeted. */
  readonly budgetAmountMinor: number | null;
  /** ISO-4217 alphabetic code for the amount, or null. */
  readonly currency: string | null;
  /** Effort already logged on the project's work items, in hours. */
  readonly trackedHours: number;
  /** `budgetHours - trackedHours`; positive is effort left, negative is overrun. Null with no effort budget. */
  readonly remainingHours: number | null;
  /** `trackedHours - budgetHours`; positive is over budget. Null with no effort budget. */
  readonly varianceHours: number | null;
  /** When the budget was last saved (ISO-8601), or null when none has been set. */
  readonly updatedAt: string | null;
}

export async function getProjectBudget(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<ProjectBudgetSummary> {
  const { data } = await client.request<ProjectBudgetSummary>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/budget`,
  });
  return data;
}

export interface SaveProjectBudgetInput {
  /** Planned effort in hours (>= 0, whole-minute increments). Omit to budget only an amount. */
  readonly budgetHours?: number;
  /** Planned amount in minor units (>= 0). Omit to budget only effort. Requires `currency`. */
  readonly budgetAmountMinor?: number;
  /** ISO-4217 alphabetic code — required with an amount, omitted without one. */
  readonly currency?: string;
}

/** Set or replace a project's budget. At least one of `budgetHours` / `budgetAmountMinor` is required. */
export async function saveProjectBudget(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  input: SaveProjectBudgetInput,
): Promise<ProjectBudgetSummary> {
  const { data } = await client.request<ProjectBudgetSummary>({
    method: 'PUT',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/budget`,
    body: input,
  });
  return data;
}
