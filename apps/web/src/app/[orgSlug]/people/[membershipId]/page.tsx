'use client';

import { use } from 'react';
import { PersonProfileScreen } from '../../../../components/screens/PersonProfileScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Person profile** — x169's per-member detail under the People rail.
 *
 * Under `[orgSlug]/people/[membershipId]`, matching the API route shape: the slug is the claim the
 * API's `TenantContextGuard` resolves against a membership row, and the membership id is resolved
 * tenant-scoped on the server (a cross-tenant/unknown id is a 404). The screen reads
 * `GET …/people/:membershipId`, gated on `work.read`, so a caller without it sees the API's refusal
 * rather than a blank page. Disjoint from the `/people` directory route (x168).
 */
export default function PersonProfilePage({
  params,
}: {
  params: Promise<{ orgSlug: string; membershipId: string }>;
}) {
  const { orgSlug, membershipId } = use(params);

  return (
    <PersonProfileScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      membershipId={membershipId}
    />
  );
}
