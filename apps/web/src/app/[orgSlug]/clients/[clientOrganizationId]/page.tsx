'use client';

import { use } from 'react';
import { ClientCompanyScreen } from '../../../../components/screens/ClientCompanyScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Client company** — one client organization, opened from a row on Clients (2026-10-31 live-test
 * fix; Figma "Clients · Client company detail" 446:37327). Served by the BK1 client-organization
 * routes behind `org.manage`.
 */
export default function ClientCompanyPage({
  params,
}: {
  params: Promise<{ orgSlug: string; clientOrganizationId: string }>;
}) {
  const { orgSlug, clientOrganizationId } = use(params);

  return (
    <ClientCompanyScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      clientOrganizationId={clientOrganizationId}
    />
  );
}
