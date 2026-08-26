'use client';

import { useRouter } from 'next/navigation';
import { CreateOrganizationScreen } from '../../../components/screens/CreateOrganizationScreen';
import { FIXTURE_SIGNED_IN_AS } from '../../../lib/fixtures';

/**
 * **ON-01 Create organization.**
 *
 * Creating is real as of TEN-001's second half; the identity line is still a fixture, because
 * no endpoint returns the signed-in person's own profile yet.
 */
export default function CreateOrganizationPage() {
  const router = useRouter();
  return (
    <CreateOrganizationScreen
      signedInAs={FIXTURE_SIGNED_IN_AS}
      // Straight on to the next step of the sequence rather than to a home screen
      // that does not exist yet.
      onCreated={(slug) => router.push(`/${slug}/onboarding/template`)}
    />
  );
}
