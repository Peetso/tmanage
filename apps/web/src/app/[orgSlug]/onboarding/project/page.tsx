'use client';

import { use } from 'react';
import { useRouter } from 'next/navigation';
import { FirstProjectScreen } from '../../../../components/screens/FirstProjectScreen';

/**
 * **ON-03 Create first project.**
 *
 * Under `[orgSlug]` because a project belongs to an organization, and the slug in the path is
 * the claim the API's `TenantContextGuard` resolves against a membership row. A slug the
 * caller has no membership in produces the same refusal as one that does not exist.
 *
 * The identity line is left empty (the owner reads "You"): no endpoint returns the signed-in
 * person's profile yet, and a sample address would mislead.
 */
export default function FirstProjectPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  const router = useRouter();

  return (
    <FirstProjectScreen
      signedInAs=""
      organizationSlug={orgSlug}
      // ON-02 is always done by now: ON-01 stores the starting template and ON-02 only refines it.
      completedSteps={['ON-02']}
      onCreated={() => router.push(`/${orgSlug}/onboarding/team?project=created`)}
    />
  );
}
