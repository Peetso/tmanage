'use client';

import { use } from 'react';
import { ConnectedAppsScreen } from '../../../../components/screens/ConnectedAppsScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Control center > Connected apps** (MCP connector S11, Figma S0-2) at
 * `/{orgSlug}/settings/connected-apps`. Every member manages the AI apps they connected; an owner
 * sees all of them and the workspace switch. The organization name is resolved inside the screen.
 */
export default function ConnectedAppsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  return (
    <ConnectedAppsScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
