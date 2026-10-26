'use client';

import { use, useEffect } from 'react';
import { ConnectedAppsScreen } from '../../../../components/screens/ConnectedAppsScreen';
import { readCalendarReturn } from '../../../../lib/api/calendar-connections';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Control center > Connected apps** (MCP connector S11, Figma S0-2) at
 * `/{orgSlug}/settings/connected-apps`. Every member manages the AI apps they connected; an owner
 * sees all of them and the workspace switch. The organization name is resolved inside the screen.
 *
 * The calendar callbacks (0237) land here with `#gcal=…` / `#mscal=…`; that hand-over belongs to
 * Settings › Calendar connections, so the fragment is forwarded there unchanged.
 */
export default function ConnectedAppsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  useEffect(() => {
    const hash = globalThis.location?.hash ?? '';
    if (readCalendarReturn(hash) !== null) {
      globalThis.location.replace(`/${orgSlug}/settings/calendar-connections${hash}`);
    }
  }, [orgSlug]);
  return (
    <ConnectedAppsScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
