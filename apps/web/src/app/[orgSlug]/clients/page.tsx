'use client';

import { use } from 'react';
import { ClientsScreen } from '../../../components/screens/ClientsScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../lib/fixtures';

/**
 * **Clients** — the internal rail's client-companies destination (Q1, Figma t5-a): the client
 * organizations, their pending invitations, and "Invite client" (t5-b). Served by the BK1
 * client-organization routes behind `org.manage`.
 */
export default function ClientsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return <ClientsScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />;
}
