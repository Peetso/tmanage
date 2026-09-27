'use client';

import { use } from 'react';
import { PolicySimulationScreen } from '../../../../components/screens/PolicySimulationScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Access-policy simulation (Administration module 18, x196).**
 *
 * Under `[orgSlug]/policies/simulate`: the slug in the path is the claim the API's `TenantContextGuard`
 * resolves against a membership row, and the simulate route sits behind `org.manage`. The organization
 * name is still a fixture, for `WorkPage`'s reason: no endpoint returns the current organization's
 * profile by slug.
 */
export default function PolicySimulationPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <PolicySimulationScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
