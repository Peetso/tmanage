'use client';

import { use } from 'react';
import { OnboardingTourScreen } from '../../../../components/screens/OnboardingTourScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **ON-10 guided tour progress (x155).**
 *
 * Under `[orgSlug]` because progress belongs to a membership in an organization, and the slug in the
 * path is the claim the API's `TenantContextGuard` resolves against a membership row. A slug the
 * caller has no membership in produces the same refusal as one that does not exist.
 *
 * The organization name is still a fixture: no endpoint returns it for the shell header here, the
 * posture the other `[orgSlug]` screens take until one lands.
 */
export default function OnboardingTourPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <OnboardingTourScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
