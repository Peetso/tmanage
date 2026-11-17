'use client';

import { use } from 'react';
import { PortalJourneyFormScreen } from '../../../../../components/screens/PortalJourneyFormScreen';
import { FIXTURE_CLIENT_NAME, FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/** **52-27 Journey form step** — the client fills the form one of their journey steps asks for. */
export default function PortalJourneyStepPage({
  params,
}: {
  params: Promise<{ orgSlug: string; stepId: string }>;
}) {
  const { orgSlug, stepId } = use(params);

  return (
    <PortalJourneyFormScreen
      organizationSlug={orgSlug}
      stepId={stepId}
      clientName={FIXTURE_CLIENT_NAME}
      providerName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
