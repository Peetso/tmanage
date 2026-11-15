'use client';

import { use } from 'react';
import { AutomationBuilderScreen } from '../../../../../../components/screens/AutomationBuilderScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../../lib/fixtures';

/**
 * **Automations — branching rule builder (58-C1).** One rule's When > If > Yes/No > Then steps,
 * read from and saved to `…/automations/templates/:id/flow` behind `org.manage`. The organization
 * name is a fixture for the sibling rule page's reason.
 */
export default function AutomationBuilderPage({
  params,
}: {
  params: Promise<{ orgSlug: string; templateId: string }>;
}) {
  const { orgSlug, templateId } = use(params);
  return (
    <AutomationBuilderScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      templateId={templateId}
    />
  );
}
