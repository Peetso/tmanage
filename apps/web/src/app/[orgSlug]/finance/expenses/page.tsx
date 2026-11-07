'use client';

import { use } from 'react';
import { FinanceExpensesScreen } from '../../../../components/screens/finance/FinanceExpensesScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/** A10a — finance expenses (Figma "R31 A10a Finance", section 508:30241). The API checks access. */
export default function FinanceExpensesPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  return (
    <FinanceExpensesScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
