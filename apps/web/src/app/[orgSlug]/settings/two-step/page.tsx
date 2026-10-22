'use client';

import { use } from 'react';
import { TwoStepSignInScreen } from '../../../../components/screens/TwoStepSignInScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Two-step sign-in (t2-c)** at `/{orgSlug}/settings/two-step`: turn on an authenticator app,
 * save the recovery codes once, or turn the factor off. The organization name is still a fixture,
 * the reason every sibling settings screen gives.
 */
export default function TwoStepPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  return (
    <TwoStepSignInScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
