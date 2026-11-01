'use client';

import { use } from 'react';
import { FigmaStage } from '../../../../components/viewer/FigmaStage';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Figma link in the viewer (R4 slice 13, V-23).** The frames of one attached Figma file: the
 * snapshots with their pins, the frame strip, Live mode for people whose Figma account can open
 * the file, and the comments rail. `?thread=` opens one thread.
 */
export default function FigmaLinkPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; linkId: string }>;
  searchParams: Promise<{ thread?: string }>;
}) {
  const { orgSlug, linkId } = use(params);
  const query = use(searchParams);
  return (
    <FigmaStage
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      linkId={linkId}
      {...(typeof query.thread === 'string' ? { initialThreadId: query.thread } : {})}
    />
  );
}
