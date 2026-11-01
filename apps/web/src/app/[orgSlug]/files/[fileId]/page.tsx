'use client';

import { use } from 'react';
import { FileViewer } from '../../../../components/viewer/FileViewer';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **File viewer (R4, V-01 – V-15).** Opens one file in the proofing viewer: the image or PDF with
 * its numbered pins and boxes, and the comments rail. `?deliverableVersionId=` when opened from a
 * deliverable version; `?thread=` opens one thread (links from notifications and emails).
 */
export default function FileViewerPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; fileId: string }>;
  searchParams: Promise<{ deliverableVersionId?: string; thread?: string }>;
}) {
  const { orgSlug, fileId } = use(params);
  const query = use(searchParams);

  return (
    <FileViewer
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      fileId={fileId}
      {...(typeof query.deliverableVersionId === 'string'
        ? { deliverableVersionId: query.deliverableVersionId }
        : {})}
      {...(typeof query.thread === 'string' ? { initialThreadId: query.thread } : {})}
    />
  );
}
