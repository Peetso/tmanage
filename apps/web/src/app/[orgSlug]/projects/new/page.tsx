'use client';

import { use } from 'react';
import { useRouter } from 'next/navigation';
import { FirstProjectScreen } from '../../../../components/screens/FirstProjectScreen';
import { useOrganizationSummary } from '../../../../components/projects/NewProjectLink';

/**
 * **New project** — the create-project form for every project after the first.
 *
 * `new` is a static segment, so Next.js matches it before the sibling `[projectId]`. It reuses
 * ON-03's form in its `new` mode (inside the app shell, rail kept) and, once the project exists,
 * opens it. The API's `@RequireCapability('project.create')` is the gate; the "New project"
 * buttons that lead here are only shown to roles whose ceiling holds that capability.
 */
export default function NewProjectPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  const router = useRouter();
  const organization = useOrganizationSummary(orgSlug);

  return (
    <FirstProjectScreen
      mode="new"
      signedInAs="You"
      organizationSlug={orgSlug}
      organizationName={organization?.name ?? ''}
      onCreated={(projectId) => router.push(`/${orgSlug}/projects/${projectId}`)}
    />
  );
}
