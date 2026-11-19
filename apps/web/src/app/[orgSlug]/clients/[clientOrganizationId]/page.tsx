'use client';

import { use } from 'react';
import { useSearchParams } from 'next/navigation';
import { ClientCompanyScreen } from '../../../../components/screens/ClientCompanyScreen';
import { parseClientView } from '../../../../components/overview/overview-links';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Client company** — one client organization, opened from a row on Clients (2026-10-31 live-test
 * fix; ONEPAGE Figma 740:40765). Served by the BK1 client-organization routes behind `org.manage`.
 * `?view=` names the tab (Overview, Projects, People); `?health=at-risk` narrows Projects to the
 * projects at risk, the way the Risks block hands off.
 */
export default function ClientCompanyPage({
  params,
}: {
  params: Promise<{ orgSlug: string; clientOrganizationId: string }>;
}) {
  const { orgSlug, clientOrganizationId } = use(params);
  const search = useSearchParams();
  const view = parseClientView(search.get('view'));

  return (
    <ClientCompanyScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      clientOrganizationId={clientOrganizationId}
      view={view}
      atRisk={view === 'projects' && search.get('health') === 'at-risk'}
    />
  );
}
