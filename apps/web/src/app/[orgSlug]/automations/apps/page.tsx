'use client';

import { use } from 'react';
import { IntegrationDirectoryScreen } from '../../../../components/screens/IntegrationDirectoryScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Automations app directory (x165).**
 *
 * Under `[orgSlug]/automations/apps`, matching the API route shape: the slug in the path is the claim
 * the API's `TenantContextGuard` resolves against a membership row. The screen reads
 * `GET …/automations/apps`, gated on `org.manage`, so a caller without it sees the API's refusal
 * rather than a blank page. The organization name is still a fixture, for `WorkPage`'s reason: no
 * endpoint returns the current organization's profile by slug.
 */
export default function IntegrationDirectoryPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = use(params);

  return (
    <IntegrationDirectoryScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
