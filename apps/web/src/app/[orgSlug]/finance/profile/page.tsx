'use client';

import { use } from 'react';
import { FinanceProfileScreen } from '../../../../components/screens/finance/FinanceProfileScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/** A10a — finance profile (Figma "R31 A10a Finance", section 508:30241). The API checks access. */
export default function FinanceProfilePage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  return (
    <FinanceProfileScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
