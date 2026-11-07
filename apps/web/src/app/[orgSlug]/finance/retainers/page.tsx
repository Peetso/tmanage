'use client';

import { use } from 'react';
import { RetainerListScreen } from '../../../../components/screens/finance/RetainerListScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Retainers** — client retainers and their periods (A10b). Not on the internal rail; reached from the finance home and the
 * finance tabs. The API enforces each capability, so a caller without it sees the refusal.
 */
export default function FinanceRetainersPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <RetainerListScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
