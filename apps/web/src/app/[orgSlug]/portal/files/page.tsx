'use client';

import { use } from 'react';
import { PortalFilesScreen } from '../../../../components/screens/PortalFilesScreen';
import { FIXTURE_CLIENT_NAME, FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Files** — the sixth destination on the client portal nav (`22-SCREEN-BY-SCREEN` §1).
 *
 * FILE-003 · WEB-006. The client's downloadable files, over the FILE-002 download surface: this
 * route now renders {@link PortalFilesScreen} rather than the planned-screen stub. The files a
 * client may see are the request attachments the download door would serve; published deliverables
 * and portal uploads remain unbuilt and are named there rather than shown empty.
 */
export default function PortalFilesPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <PortalFilesScreen
      organizationSlug={orgSlug}
      clientName={FIXTURE_CLIENT_NAME}
      providerName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
