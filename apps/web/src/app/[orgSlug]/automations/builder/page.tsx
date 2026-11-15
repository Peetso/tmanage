'use client';

import { use } from 'react';
import { AutomationBuilderStartScreen } from '../../../../components/screens/AutomationBuilderStartScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/** **Automations — start a branching rule (58-C1).** Pick a trigger, then build it. */
export default function AutomationBuilderStartPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = use(params);
  return (
    <AutomationBuilderStartScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
