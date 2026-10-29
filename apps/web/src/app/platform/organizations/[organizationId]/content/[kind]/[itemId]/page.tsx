'use client';

import { use } from 'react';
import { PlatformContentItemScreen } from '../../../../../../../components/platform/content/ContentViewer';

/** Platform admin — B6, one content item: viewer and moderation panel. */
export default function Page({
  params,
}: {
  params: Promise<{ organizationId: string; kind: string; itemId: string }>;
}) {
  const { organizationId, kind, itemId } = use(params);
  return <PlatformContentItemScreen organizationId={organizationId} kind={kind} itemId={itemId} />;
}
