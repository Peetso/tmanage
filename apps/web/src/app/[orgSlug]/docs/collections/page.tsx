'use client';

import { use } from 'react';
import { DocCollectionsScreen } from '../../../../components/screens/DocCollectionsScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **DOC collections (x264).** Group documents into named collections (lightweight wiki spaces).
 *
 * The organization name is still a fixture, as the sibling docs pages note: no endpoint returns the
 * current organization's profile by slug.
 */
export default function DocCollectionsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <DocCollectionsScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
