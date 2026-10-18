'use client';

import { use } from 'react';
import { useRouter } from 'next/navigation';
import { OperatingTemplateScreen } from '../../../../components/screens/OperatingTemplateScreen';

/**
 * **ON-02 Choose operating template.**
 *
 * Under `[orgSlug]` because the template is a property of an organization: "Use this template"
 * saves it as that organization's `operating_template` setting, then moves on to the first
 * project.
 */
export default function OperatingTemplatePage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = use(params);
  const router = useRouter();
  return (
    <OperatingTemplateScreen
      signedInAs=""
      organizationSlug={orgSlug}
      onContinue={() => router.push(`/${orgSlug}/onboarding/project`)}
    />
  );
}
