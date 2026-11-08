'use client';

import { use } from 'react';
import { WorkingCalendarScreen } from '../../../../components/screens/WorkingCalendarScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Working calendar (53-02).** Under `[orgSlug]/admin/working-calendar`: the company's working
 * days, hours, time zone and holidays. Reading is `work.read`; every change is `org.manage`,
 * decided by the API.
 */
export default function WorkingCalendarPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <WorkingCalendarScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
