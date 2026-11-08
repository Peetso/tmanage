'use client';

import { use } from 'react';
import { SignInSecurityScreen } from '../../../../components/screens/SignInSecurityScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Sign-in security (56-22)** at `/{orgSlug}/settings/sign-in-security`: the security score,
 * passkeys and signed-in devices. The organization name is still a fixture, the reason every
 * sibling settings screen gives.
 */
export default function SignInSecurityPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  return (
    <SignInSecurityScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
