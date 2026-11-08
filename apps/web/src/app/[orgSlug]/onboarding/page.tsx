'use client';

import { use } from 'react';
import { useRouter } from 'next/navigation';
import { OnboardingWizardScreen } from '../../../components/onboarding/OnboardingWizardScreen';

/**
 * **55-01 — the onboarding wizard**, the first stop after a company is created. Finish and
 * "Skip setup" both land on My Day (`/{slug}/home`); the wizard's position is stored per company,
 * so reopening this address resumes it.
 */
export default function OnboardingWizardPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  const router = useRouter();
  return (
    <OnboardingWizardScreen
      organizationSlug={orgSlug}
      onLeave={() => router.push(`/${encodeURIComponent(orgSlug)}/home`)}
    />
  );
}
