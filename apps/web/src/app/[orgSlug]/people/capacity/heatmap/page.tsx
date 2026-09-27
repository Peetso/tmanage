'use client';

import { use } from 'react';
import { TeamCapacityHeatmapScreen } from '../../../../../components/screens/TeamCapacityHeatmapScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * **Team capacity heatmap** — PEOPLE / module 14 (x193).
 *
 * Under `[orgSlug]/people/capacity/heatmap`: the slug is the claim the API's `TenantContextGuard`
 * resolves against a membership row. The screen reads `GET …/people/capacity/heatmap`, gated on the
 * server by `work.read`, so a caller without the capability sees the API's refusal rather than a blank
 * page.
 */
export default function TeamCapacityHeatmapPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = use(params);

  return (
    <TeamCapacityHeatmapScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
