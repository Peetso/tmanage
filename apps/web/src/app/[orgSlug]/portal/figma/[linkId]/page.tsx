'use client';

import { use } from 'react';
import { PortalFigmaStage } from '../../../../../components/viewer/FigmaStage';
import { FIXTURE_CLIENT_NAME, FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * **Portal Figma link (R4 slice 13, V-23).** The snapshots of the frames the team shared with the
 * client, with the client-visible comments. `?thread=` opens one thread.
 */
export default function PortalFigmaLinkPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; linkId: string }>;
  searchParams: Promise<{ thread?: string }>;
}) {
  const { orgSlug, linkId } = use(params);
  const query = use(searchParams);
  return (
    <PortalFigmaStage
      organizationSlug={orgSlug}
      linkId={linkId}
      clientName={FIXTURE_CLIENT_NAME}
      providerName={FIXTURE_ORGANIZATION_NAME}
      {...(typeof query.thread === 'string' ? { initialThreadId: query.thread } : {})}
    />
  );
}
