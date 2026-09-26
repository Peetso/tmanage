'use client';

import { use } from 'react';
import { InsightsAdoptionScreen } from '../../../../components/screens/InsightsAdoptionScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Adoption** — INS-06's org-wide insights read.
 *
 * Under `[orgSlug]/insights/adoption`, matching the API route shape: the slug in the path is the
 * claim the API's `TenantContextGuard` resolves against a membership row. The screen reads
 * `GET …/insights/adoption`, gated on `work.read`, so a caller without it sees the API's refusal
 * rather than a blank page. Disjoint from the project-scoped insights routes (x120/x123).
 */
export default function InsightsAdoptionPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <InsightsAdoptionScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
