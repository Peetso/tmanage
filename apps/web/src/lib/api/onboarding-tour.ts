import type { ApiClient } from './client';

/**
 * The ON-10 guided-tour progress endpoints (x155).
 *
 * Behind `work.read` on the API and taking no membership id: progress is always the acting member's
 * own. The tour is a fixed, ordered step set; the response carries every step with the member's
 * completed flag (default false), so a screen renders the checklist from one response. Completing a
 * step is idempotent — a re-complete answers 200 with the same progress — and an unknown step is a
 * 400.
 */
export type OnboardingTourStep =
  'welcome' | 'create_project' | 'invite_team' | 'explore_work' | 'share_portal';

/**
 * The acting member's guided tour: every fixed step, in presentation order, with its completed flag.
 * Each item is inlined rather than a second exported shape, so the API↔web pairing is the one
 * `OnboardingTourView` projection. `completedAt` is null for a step the member has not finished.
 */
export interface OnboardingTourView {
  readonly steps: readonly {
    readonly step: OnboardingTourStep;
    readonly label: string;
    readonly completed: boolean;
    readonly completedAt: string | null;
  }[];
}

export async function getOnboardingTour(
  client: ApiClient,
  organizationSlug: string,
): Promise<OnboardingTourView> {
  const { data } = await client.request<OnboardingTourView>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/onboarding/tour`,
  });
  return data;
}

export async function completeOnboardingTourStep(
  client: ApiClient,
  organizationSlug: string,
  step: OnboardingTourStep,
): Promise<OnboardingTourView> {
  const { data } = await client.request<OnboardingTourView>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/onboarding/tour/${encodeURIComponent(step)}/complete`,
  });
  return data;
}
