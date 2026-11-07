'use client';

import { use } from 'react';
import { FinanceTimesheetsScreen } from '../../../../components/screens/finance/FinanceTimesheetsScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/** A10a — finance timesheets (Figma "R31 A10a Finance", section 508:30241). The API checks access. */
export default function FinanceTimesheetsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = use(params);
  return (
    <FinanceTimesheetsScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
