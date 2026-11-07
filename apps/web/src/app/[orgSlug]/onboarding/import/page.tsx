'use client';

import { use } from 'react';
import { ImportStartScreen } from '../../../../components/screens/ImportStartScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Import start** (R31 A11) — ON-09 / ADM-10. Choose a source, upload and map the export, check
 * it, start it, and undo a recent import. The receipt for a started import lives one level down at
 * `[orgSlug]/onboarding/import/[jobId]`. Like the receipt, it is not on the internal rail.
 */
export default function ImportStartPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <ImportStartScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
