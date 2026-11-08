'use client';

import { use } from 'react';
import { AdminIncidentsScreen } from '../../../../components/screens/AdminIncidentsScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * A17 · **Incidents** — the workspace owner's view of TManage incidents that touch this workspace.
 * Reads `GET /v1/organizations/:orgSlug/admin/incidents` (`org.manage`). The organization name is
 * a fixture the shell replaces with the live name, as on the sessions page.
 */
export default function AdminIncidentsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  return (
    <AdminIncidentsScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
