'use client';

import { use } from 'react';
import { FinanceReportIndexScreen } from '../../../components/screens/finance/FinanceReportIndexScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../lib/fixtures';

/**
 * **Finance** — the finance home: links to the eight finance areas (A10b). Not on the internal rail; reached from the finance home and the
 * finance tabs. The API enforces each capability, so a caller without it sees the refusal.
 */
export default function FinancePage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <FinanceReportIndexScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
