'use client';

import { use } from 'react';
import { FinanceRatesScreen } from '../../../../components/screens/finance/FinanceRatesScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/** A10a — finance rates (Figma "R31 A10a Finance", section 508:30241). The API checks access. */
export default function FinanceRatesPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  return (
    <FinanceRatesScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
