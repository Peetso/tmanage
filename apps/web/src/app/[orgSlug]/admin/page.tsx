'use client';

import { use } from 'react';
import { AdminOverviewScreen } from '../../../components/screens/AdminOverviewScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../lib/fixtures';

/**
 * **Administration** — the module 18 overview (x175).
 *
 * Like the audit log it is not one of the eight internal-rail destinations (`22-SCREEN-BY-SCREEN`
 * §1), so this route names none and adds no nav entry — it is the administration front door, reached
 * directly. The screen reads `GET /v1/organizations/:orgSlug/admin/overview`, gated on `org.manage`,
 * so a caller without the capability sees the API's refusal rather than a blank page.
 */
export default function AdminOverviewPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <AdminOverviewScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
