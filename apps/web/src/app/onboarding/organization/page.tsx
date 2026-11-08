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
      // 55-01: straight on to the three-minute onboarding wizard.
      onCreated={(slug) => router.push(`/${slug}/onboarding`)}
    />
  );
}
