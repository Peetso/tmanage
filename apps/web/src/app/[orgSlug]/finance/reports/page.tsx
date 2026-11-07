'use client';

import { use } from 'react';
import { FinanceReportScreen } from '../../../../components/screens/finance/FinanceReportScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Finance reports** — receivables aging and accounting exports (A10b). Not on the internal rail; reached from the finance home and the
 * finance tabs. The API enforces each capability, so a caller without it sees the refusal.
 */
export default function FinanceReportsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <FinanceReportScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
