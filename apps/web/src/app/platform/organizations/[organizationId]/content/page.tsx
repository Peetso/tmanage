'use client';

import { use } from 'react';
import { PlatformContentScreen } from '../../../../../components/platform/content/ContentBrowser';

/** Platform admin — B5, the content browser of one organization (support session required). */
export default function Page({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = use(params);
  return <PlatformContentScreen organizationId={organizationId} />;
}
