'use client';

import { use } from 'react';
import { useRouter } from 'next/navigation';
import { FirstProjectScreen } from '../../../../components/screens/FirstProjectScreen';
import { FIXTURE_SIGNED_IN_AS } from '../../../../lib/fixtures';

/**
 * **ON-03 Create first project.**
 *
 * Under `[orgSlug]` because a project belongs to an organization, and the slug in the path is
 * the claim the API's `TenantContextGuard` resolves against a membership row. A slug the
 * caller has no membership in produces the same refusal as one that does not exist.
 *
 * The identity line is still a fixture: no endpoint returns the signed-in person's profile.
 */
export default function FirstProjectPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  const router = useRouter();

  return (
    <FirstProjectScreen
      signedInAs={FIXTURE_SIGNED_IN_AS}
      organizationSlug={orgSlug}
      onCreated={() => router.push(`/${orgSlug}/onboarding/team`)}
    />
  );
}
