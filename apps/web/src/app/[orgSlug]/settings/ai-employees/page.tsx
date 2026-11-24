'use client';

import { use } from 'react';
import { AiEmployeesSettingsScreen } from '../../../../components/ai-employees/AiEmployeesSettingsScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Settings › AI employees** (plan 60, S8): the workspace switch, who may hire and give work to
 * AI, the client-work rules and the projects closed to AI.
 *
 * At `/{orgSlug}/settings/ai-employees`, in the Control Center's People group. Owner and admin
 * only: the menu shows the entry to `ai_employee.manage` and the API refuses everyone else. The
 * organization name is still a fixture, the reason every sibling settings screen gives.
 */
export default function AiEmployeesSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = use(params);
  return (
    <AiEmployeesSettingsScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
