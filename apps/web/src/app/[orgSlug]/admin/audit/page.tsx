'use client';

import { use } from 'react';
import { AdminAuditScreen } from '../../../../components/screens/AdminAuditScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Audit log** — the Administration audit viewer (ADM, x115).
 *
 * Like `billing`, it is not one of the eight internal-rail destinations (`22-SCREEN-BY-SCREEN`
 * §1), so this route names none and adds no nav entry — it is reached directly. The screen reads
 * `GET /v1/organizations/:orgSlug/audit/events`, gated on `audit.read`, so a caller without the
 * capability sees the API's refusal rather than a blank page.
 */
export default function AdminAuditPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <AdminAuditScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
