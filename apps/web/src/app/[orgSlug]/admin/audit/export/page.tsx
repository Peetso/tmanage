'use client';

import { use } from 'react';
import { AuditExportScreen } from '../../../../../components/screens/AuditExportScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * **Export audit log** — the ADM-09 filtered export (module 18, x197).
 *
 * Reached directly from the audit viewer; like `audit` it is not one of the internal-rail
 * destinations and adds no nav entry. The screen builds a download link to
 * `GET /v1/organizations/:orgSlug/audit/export.csv`, gated on `audit.export`, so a caller without
 * the capability sees the API's refusal when the browser fetches the file rather than a blank page.
 */
export default function AuditExportPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <AuditExportScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
