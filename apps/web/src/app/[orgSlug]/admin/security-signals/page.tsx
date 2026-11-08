'use client';

import { use } from 'react';
import { AdminSecuritySignalsScreen } from '../../../../components/screens/AdminSecuritySignalsScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Security signals** — 56-23 owner view (R44 L2, Figma 578:32859): the company's own signals
 * with filters and mark-reviewed. Reads `GET .../admin/security/events` (`audit.read`).
 */
export default function AdminSecuritySignalsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = use(params);
  return (
    <AdminSecuritySignalsScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
