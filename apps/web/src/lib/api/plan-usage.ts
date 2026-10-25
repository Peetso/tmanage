import type { ApiClient } from './client';

/**
 * Plan and usage (Figma F4) — the two reads behind the billing home and its change preview.
 *
 * Hand-written for the boundary reason `errors.ts` gives and paired `Exact` with the API
 * projections in `e2e/contracts/api-web-shapes.ts`. Both routes sit behind `org.manage` on the
 * server; the tenant is the slug in the path, resolved against the caller's membership. The
 * preview computes what a change would cost; nothing here charges or writes.
 */

export type UsageLevel = 'normal' | 'near' | 'over';

export interface PlanUsageMeterView {
  readonly used: number;
  readonly limit: number | null;
  readonly level: UsageLevel;
}

export interface PlanUsageView {
  readonly planId: string;
  readonly pendingChange: boolean;
  readonly currency: string;
  readonly monthlyCents: number | null;
  readonly renewsOn: string | null;
  readonly level: UsageLevel;
  readonly graceEndsOn: string | null;
  readonly people: PlanUsageMeterView;
  readonly projects: PlanUsageMeterView;
  readonly storage: PlanUsageMeterView;
  readonly clients: number;
  readonly nextPlanId: string | null;
  readonly nextPlanPeopleLimit: number | null;
  readonly nextPlanStorageBytes: number | null;
  readonly measuredAt: string;
}

export type PlanChangeKind = 'people' | 'projects' | 'storage' | 'feature';

export interface PlanUsageChangeView {
  readonly kind: PlanChangeKind;
  readonly feature: string | null;
  readonly direction: 'gain' | 'lose';
  readonly fromLimit: number | null;
  readonly toLimit: number | null;
  readonly used: number | null;
  readonly fits: boolean;
}

export interface PlanUsageOverageView {
  readonly kind: 'people' | 'projects' | 'storage';
  readonly limit: number;
  readonly over: number;
}

export interface PlanUsagePreviewView {
  readonly currentPlanId: string;
  readonly targetPlanId: string;
  readonly direction: 'upgrade' | 'downgrade';
  readonly currency: string;
  readonly currentMonthlyCents: number;
  readonly targetMonthlyCents: number;
  readonly startsOn: string;
  readonly startsToday: boolean;
  readonly dueTodayCents: number;
  readonly daysLeft: number;
  readonly fullPriceFrom: string;
  readonly changes: readonly PlanUsageChangeView[];
  readonly overages: readonly PlanUsageOverageView[];
  readonly graceEndsOn: string | null;
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/billing/plan-usage`;
}

export async function fetchPlanUsage(
  client: ApiClient,
  organizationSlug: string,
): Promise<PlanUsageView> {
  const { data } = await client.request<PlanUsageView>({ path: base(organizationSlug) });
  return data;
}

export async function fetchPlanUsagePreview(
  client: ApiClient,
  organizationSlug: string,
  target: string,
): Promise<PlanUsagePreviewView> {
  const { data } = await client.request<PlanUsagePreviewView>({
    path: `${base(organizationSlug)}/preview?target=${encodeURIComponent(target)}`,
  });
  return data;
}
