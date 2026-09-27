'use client';

import { use } from 'react';
import { OrgChartScreen } from '../../../../components/screens/OrgChartScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Org chart** — PEOPLE / module 14 (x217), under People.
 *
 * Under `[orgSlug]/people/org-chart`: the slug is the claim the API's `TenantContextGuard` resolves
 * against a membership row. The screen reads `GET …/people/org-chart` (gated on the server by
 * `work.read`) to draw the reporting tree, and sets a manager via `PUT …/people/:membershipId/manager`
 * (gated on `org.manage`), so a caller without the capability sees the API's refusal rather than a
 * blank page.
 */
export default function OrgChartPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return <OrgChartScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />;
}
