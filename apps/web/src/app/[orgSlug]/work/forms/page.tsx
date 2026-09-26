'use client';

import { use } from 'react';
import { WorkFormsScreen } from '../../../../components/screens/WorkFormsScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **WORK intake forms (x146).**
 *
 * The intake-form screen for the Work module. The organization name is still a fixture, for
 * `WorkPage`'s reason: no endpoint returns the current organization's profile by slug.
 */
export default function WorkFormsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <WorkFormsScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
