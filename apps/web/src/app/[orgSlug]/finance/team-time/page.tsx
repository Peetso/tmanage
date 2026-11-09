'use client';

import { use } from 'react';
import { FinanceTeamTimeScreen } from '../../../../components/screens/finance/FinanceTeamTimeScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/** FIX-2026-11-10 — team time, next to Timesheets. The API checks `time.view_team`. */
export default function FinanceTeamTimePage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  return (
    <FinanceTeamTimeScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
