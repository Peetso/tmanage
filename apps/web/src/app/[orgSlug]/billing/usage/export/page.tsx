'use client';

import { use } from 'react';
import { UsageExportScreen } from '../../../../../components/screens/UsageExportScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * **Export usage** — the billing usage CSV export (module 19, x227).
 *
 * Reached from billing; it adds no nav entry of its own. The screen builds a download link to
 * `GET /v1/organizations/:orgSlug/billing/usage/export.csv`, gated on `org.manage`, so a caller
 * without the capability sees the API's refusal when the browser fetches the file rather than a
 * blank page.
 */
export default function UsageExportPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <UsageExportScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
