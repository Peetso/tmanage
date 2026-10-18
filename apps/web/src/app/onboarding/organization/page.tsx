'use client';

import { useRouter } from 'next/navigation';
import { CreateOrganizationScreen } from '../../../components/screens/CreateOrganizationScreen';

/**
 * **ON-01 Create organization.**
 *
 * Creating is real as of TEN-001's second half; the identity line is left empty, because no
 * endpoint returns the signed-in person's own profile yet and a sample address would mislead.
 */
export default function CreateOrganizationPage() {
  const router = useRouter();
  return (
    <CreateOrganizationScreen
      signedInAs=""
      // Straight on to the next step of the sequence rather than to a home screen
      // that does not exist yet.
      onCreated={(slug) => router.push(`/${slug}/onboarding/template`)}
    />
  );
}
