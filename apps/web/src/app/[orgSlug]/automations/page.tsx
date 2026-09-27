'use client';

import { use } from 'react';
import { AutomationTemplatesScreen } from '../../../components/screens/AutomationTemplatesScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../lib/fixtures';

/**
 * **Automations & integrations** — module 17 (x162).
 *
 * Under `[orgSlug]/automations` (org-scoped, no project segment): the slug is the claim the API's
 * `TenantContextGuard` resolves against a membership row. The screen reads `GET …/automations/templates`
 * and writes `POST …/automations/templates`, gated on the server by `org.manage`, so a member without
 * the capability sees the API's refusal rather than a blank page. The organization name is still a
 * fixture, for the sibling admin pages' reason: no endpoint returns the current organization's profile
 * by slug.
 */
export default function AutomationsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <AutomationTemplatesScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
