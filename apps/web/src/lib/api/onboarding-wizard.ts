import type { ApiClient } from './client';

/**
 * 55-01 / 55-01a / 55-03 — the onboarding wizard's resumable state, behind `org.manage`.
 *
 * One per company: `GET …/onboarding/wizard` answers where to resume; `POST …/steps/:step` records
 * a step as done or skipped; `POST …/dismiss` is "Skip setup". Finish cannot be skipped.
 */
export type WizardStep =
  'company' | 'work_type' | 'invite' | 'storage' | 'sample_project' | 'finish';
export type WizardOutcome = 'done' | 'skipped';
export type WizardStatus = 'active' | 'completed' | 'dismissed';

export interface OnboardingWizardView {
  readonly status: WizardStatus;
  readonly currentStep: WizardStep;
  readonly steps: readonly {
    readonly step: WizardStep;
    readonly outcome: WizardOutcome | null;
  }[];
}

function wizardPath(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/onboarding/wizard`;
}

export async function getOnboardingWizard(
  client: ApiClient,
  organizationSlug: string,
): Promise<OnboardingWizardView> {
  const { data } = await client.request<OnboardingWizardView>({
    path: wizardPath(organizationSlug),
  });
  return data;
}

export async function recordOnboardingWizardStep(
  client: ApiClient,
  organizationSlug: string,
  step: WizardStep,
  outcome: WizardOutcome,
): Promise<OnboardingWizardView> {
  const { data } = await client.request<OnboardingWizardView>({
    method: 'POST',
    path: `${wizardPath(organizationSlug)}/steps/${encodeURIComponent(step)}`,
    body: { outcome },
  });
  return data;
}

export async function dismissOnboardingWizard(
  client: ApiClient,
  organizationSlug: string,
): Promise<OnboardingWizardView> {
  const { data } = await client.request<OnboardingWizardView>({
    method: 'POST',
    path: `${wizardPath(organizationSlug)}/dismiss`,
  });
  return data;
}
