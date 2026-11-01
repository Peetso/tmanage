'use client';

import { use } from 'react';
import { PortalFileViewerScreen } from '../../../../../components/screens/PortalFileViewerScreen';
import { FIXTURE_CLIENT_NAME, FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * **Portal viewer (R4 slice 8, V-40 – V-45).** One file opened for review in the client portal:
 * the client-visible comments, the comment tools, and — with `?deliverableVersionId=` — the
 * decision card for that published version. `?thread=` opens one thread (links from notices).
 */
export default function PortalFileViewerPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; fileId: string }>;
  searchParams: Promise<{ deliverableVersionId?: string; thread?: string }>;
}) {
  const { orgSlug, fileId } = use(params);
  const query = use(searchParams);

  return (
    <PortalFileViewerScreen
      organizationSlug={orgSlug}
      fileId={fileId}
      clientName={FIXTURE_CLIENT_NAME}
      providerName={FIXTURE_ORGANIZATION_NAME}
      {...(typeof query.deliverableVersionId === 'string'
        ? { deliverableVersionId: query.deliverableVersionId }
        : {})}
      {...(typeof query.thread === 'string' ? { initialThreadId: query.thread } : {})}
    />
  );
}
