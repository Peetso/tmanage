'use client';

import { use } from 'react';
import { PlannedPortalScreen } from '../../../../components/screens/PlannedPortalScreen';
import { FIXTURE_CLIENT_NAME, FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Files** — the sixth destination on the client portal nav (`22-SCREEN-BY-SCREEN` §1).
 *
 * Client-facing files are `WEB-006` over the `FILE-003` version and download surface; neither
 * exists yet, so this route names them and shows nothing. It resolves to the portal shell so
 * the tab stays reachable and named rather than answering with a 404.
 */
export default function PortalFilesPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <PlannedPortalScreen
      organizationSlug={orgSlug}
      clientName={FIXTURE_CLIENT_NAME}
      providerName={FIXTURE_ORGANIZATION_NAME}
      activeNavigationId="files"
      title="Files"
      description="Files shared with you."
      ticket="FILE-003 · WEB-006"
    >
      Files is where documents shared with you will appear. Storage and the client file view are not
      built yet; until they are, this tab opens here rather than answering with a 404.
    </PlannedPortalScreen>
  );
}
