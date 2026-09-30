'use client';

import { use } from 'react';
import { MetricFavoritesView } from '../../../../components/screens/MetricFavoritesView';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Favorite insight metrics** (module 15, x303).
 *
 * Under `[orgSlug]/insights/favorites`, matching the API route shape: the slug in the path is the
 * claim the API's `TenantContextGuard` resolves against a membership row. The screen reads and writes
 * `…/insights/metric-favorites`, gated on `work.read`, so a caller without it sees the API's refusal
 * rather than a blank page. The organization name is still a fixture, for the sibling insights pages'
 * reason: no endpoint returns the current organization's profile by slug.
 */
export default function MetricFavoritesPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <MetricFavoritesView organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
