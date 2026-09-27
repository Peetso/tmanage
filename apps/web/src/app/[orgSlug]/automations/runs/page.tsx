'use client';

import { use } from 'react';
import { AutomationRunHistoryScreen } from '../../../../components/screens/AutomationRunHistoryScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Automations & integrations — run history** — module 17 (x164).
 *
 * Under `[orgSlug]/automations/runs` (org-scoped, no project segment): the slug is the claim the API's
 * `TenantContextGuard` resolves against a membership row. The screen reads `GET …/automations/runs` and
 * `GET …/automations/runs/:runId`, both gated on the server by `org.manage`, so a member without the
 * capability sees the API's refusal rather than a blank page. The organization name is still a fixture,
 * for the sibling automations page's reason: no endpoint returns the current organization's profile by
 * slug.
 */
export default function AutomationRunsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <AutomationRunHistoryScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
