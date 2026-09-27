'use client';

import { use } from 'react';
import { AutomationSchedulesScreen } from '../../../../components/screens/AutomationSchedulesScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Automations scheduled triggers (x167).**
 *
 * One tenant's scheduled triggers — record a cron-like recurrence for a workflow template, and list
 * the tenant's schedules soonest-due first.
 *
 * The organization name is still a fixture, for the reason the other internal routes give: no
 * endpoint returns the current organization's profile by slug.
 */
export default function AutomationSchedulesPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = use(params);

  return (
    <AutomationSchedulesScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
