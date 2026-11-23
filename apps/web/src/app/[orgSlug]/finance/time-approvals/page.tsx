'use client';

import { use } from 'react';
import { FinanceTimeApprovalsScreen } from '../../../../components/screens/finance/FinanceTimeApprovalsScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/** Time you can trust (2026-11-23): the managers' queue of time to approve. The API checks access. */
export default function FinanceTimeApprovalsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = use(params);
  return (
    <FinanceTimeApprovalsScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
