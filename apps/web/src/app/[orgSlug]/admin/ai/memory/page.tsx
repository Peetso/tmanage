'use client';

import { use } from 'react';
import { BusinessMemoryScreen } from '../../../../../components/ai-admin/BusinessMemoryScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * **Business Memory** — Control Center › AI › Business Memory (plan 62, Figma G11 771:45216). The
 * screen reads `GET …/business-memory/facts?status=all`; the API decides what each person sees.
 */
export default function BusinessMemoryPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  return (
    <BusinessMemoryScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
