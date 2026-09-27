'use client';

import { use } from 'react';
import { InsightTargetsScreen } from '../../../../components/screens/InsightTargetsScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Insight metric targets** (module 15, x230).
 *
 * Under `[orgSlug]/insights/targets`, matching the API route shape: the slug in the path is the claim
 * the API's `TenantContextGuard` resolves against a membership row. The screen reads `…/insights/targets`
 * and `…/targets/status` (gated on `work.read`) and sets a target with `…/insights/targets` (gated on
 * `org.manage`), so a caller without the capability sees the API's refusal rather than a blank page.
 * The organization name is still a fixture, for the sibling insights pages' reason: no endpoint returns
 * the current organization's profile by slug.
 */
export default function InsightTargetsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <InsightTargetsScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
