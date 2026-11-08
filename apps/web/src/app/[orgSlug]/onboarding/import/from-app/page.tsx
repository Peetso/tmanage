'use client';

import { use } from 'react';
import { PmImportScreen } from '../../../../../components/screens/PmImportScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * **Import from Trello or Asana with your own token** (R45 L3, 54-25) at
 * `/{orgSlug}/onboarding/import/from-app`. Like the import start page, not on the internal rail.
 */
export default function PmImportPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  return <PmImportScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />;
}
