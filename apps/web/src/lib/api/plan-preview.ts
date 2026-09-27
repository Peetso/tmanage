import type { ApiClient } from './client';

/**
 * The plan-change preview endpoint — Billing / module 19 (x198), behind the preview screen. Given a
 * target plan and a seat count it returns a deterministic cost estimate against the organization's
 * current subscription (`38-…` §Billing).
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired with the API projection in the
 * `e2e/contracts` shape check so the two shapes cannot drift. Gated on the server by `org.manage` —
 * owners only — so a member who reaches this client gets the ordinary 403 the shared client turns
 * into an error; there is no organization-id argument, because the tenant is the slug in the path
 * resolved against the caller's membership. This route reads only — nothing is charged.
 */

/**
 * The estimate the preview screen shows. Every money field is integer US cents; a positive
 * `estimatedDeltaCents` is an upgrade cost and a negative one a downgrade credit. Mirrors the API.
 */
export interface PlanChangePreviewView {
  readonly currentPlanId: string;
  readonly targetPlanId: string;
  readonly seats: number;
  readonly currency: string;
  readonly currentMonthlyCents: number;
  readonly targetMonthlyCents: number;
  readonly baseDeltaCents: number;
  readonly seatDeltaCents: number;
  readonly estimatedDeltaCents: number;
  /** Null on the free/base tier and until a provider sets the billing period. */
  readonly currentPeriodEnd: string | null;
}

export async function fetchPlanChangePreview(
  client: ApiClient,
  organizationSlug: string,
  target: string,
  seats: number,
): Promise<PlanChangePreviewView> {
  const query = new URLSearchParams({ target, seats: String(seats) });
  const { data } = await client.request<PlanChangePreviewView>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/billing/plan-change/preview?${query.toString()}`,
  });
  return data;
}
