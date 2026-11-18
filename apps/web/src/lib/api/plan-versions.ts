import type { ApiClient } from './client';

/**
 * 57-02 (PLANWEB) · the live plan ladder (`plan_versions`), as the pricing page and the plan screens
 * read it. Hand-written for the boundary reason `errors.ts` gives; mirrors the API views in
 * `apps/api/src/modules/billing/plan-versions.service.ts`.
 *
 * - **`GET /v1/public/plan-versions`** (`@Public()`, no session): each plan's version in force now.
 *   While billing is `beta_free` it answers `visible: false` with no plans, so no price can show.
 * - **`GET …/organizations/:orgSlug/billing/plan`** (`billing.view`): the workspace's own plan, at
 *   the version it is pinned to.
 *
 * Every figure (price, limits) comes from these answers; the web holds no price of its own.
 */

export type PlanVersionPlanId = 'free' | 'starter' | 'studio' | 'business' | 'enterprise';

export interface PlanVersionLimitsView {
  readonly people: number | null;
  readonly activeProjects: number | null;
  readonly storageBytes: number | null;
  /** Absent on a merged entitlement (the API type marks it optional). */
  readonly maxFileBytes?: number;
}

export interface PublishedPlanView {
  readonly planId: PlanVersionPlanId;
  readonly version: number;
  readonly currency: string;
  /** Integer cents; `null` is quoted per contract (Enterprise). */
  readonly monthlyCents: number | null;
  readonly yearlyCents: number | null;
  readonly limits: PlanVersionLimitsView;
  readonly features: readonly string[];
}

export interface PublishedPlansView {
  /** `false` during the free beta: show no plan, no price, no plan choice. */
  readonly visible: boolean;
  readonly plans: readonly PublishedPlanView[];
}

export interface WorkspacePlanView {
  readonly ladder: 'off' | 'on';
  readonly billingMode: 'beta_free' | 'paid';
  readonly planId: PlanVersionPlanId;
  readonly planVersion: number | null;
  readonly grandfathered: boolean;
  readonly currency: string;
  readonly monthlyCents: number | null;
  readonly yearlyCents: number | null;
  readonly limits: PlanVersionLimitsView;
  readonly features: readonly string[];
}

export async function fetchPublishedPlans(client: ApiClient): Promise<PublishedPlansView> {
  const { data } = await client.request<PublishedPlansView>({
    path: '/v1/public/plan-versions',
    authentication: 'none',
  });
  return data;
}

export async function fetchWorkspacePlan(
  client: ApiClient,
  organizationSlug: string,
): Promise<WorkspacePlanView> {
  const { data } = await client.request<WorkspacePlanView>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/billing/plan`,
  });
  return data;
}

const PLAN_IDS: readonly PlanVersionPlanId[] = [
  'free',
  'starter',
  'studio',
  'business',
  'enterprise',
];

/**
 * Where a new workspace opens after sign-up. A paid plan the API accepted opens the plan-change
 * preview on Plan and usage (`?change=`), where the ordinary request rules apply and nothing is
 * charged; otherwise (no pick, the free plan, the beta) its home, as before.
 */
export function afterSignUpPath(
  organizationSlug: string,
  planId: string | null | undefined,
): string {
  const slug = encodeURIComponent(organizationSlug);
  const plan = planFromQuery(planId);
  return plan !== null && plan !== 'free' && plan !== 'enterprise'
    ? `/${slug}/billing?change=${plan}`
    : `/${slug}/home`;
}

/**
 * A `?plan=` value read from a URL, kept only when it names a catalog plan. Still untrusted: the
 * API checks it against the versions in force and never takes a price from it.
 */
export function planFromQuery(value: string | null | undefined): PlanVersionPlanId | null {
  return value !== null && value !== undefined && (PLAN_IDS as readonly string[]).includes(value)
    ? (value as PlanVersionPlanId)
    : null;
}
