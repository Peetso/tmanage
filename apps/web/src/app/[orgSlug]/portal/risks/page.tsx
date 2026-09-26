'use client';

import { use } from 'react';
import { PortalRisksScreen } from '../../../../components/screens/PortalRisksScreen';
import { FIXTURE_CLIENT_NAME, FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Risks** — the client portal's risk register (`22-SCREEN-BY-SCREEN` §1, the portal audit's
 * "risks — unscheduled").
 *
 * SEC / Portal risks (x140): the published risks for the client's project, from a projection that
 * carries only the client-facing summary, the severity and the status — never the internal note, the
 * title, the author or the publish flag. Any risk edit/unpublish lifecycle is a later slice
 * (NEXT-SCOPES-13).
 */
export default function PortalRisksPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <PortalRisksScreen
      organizationSlug={orgSlug}
      clientName={FIXTURE_CLIENT_NAME}
      providerName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
