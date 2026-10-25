'use client';

import { Suspense, use } from 'react';
import { PlanUsageScreen } from '../../../components/screens/PlanUsageScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../lib/fixtures';

/**
 * **Plan and usage** — the billing home, Figma F4 (section 390:22381), replacing the storage-only
 * BIL-01 screen: the flat plan, usage against its limits, and the change preview.
 *
 * It is not on the internal rail (`22-SCREEN-BY-SCREEN` §1 fixes that at eight destinations and
 * billing is not among them), so it is reached from the Control Center. The screen reads
 * `GET /v1/organizations/:orgSlug/billing/plan-usage`, gated on `org.manage`, so a member without
 * it sees the API's refusal rather than a blank page. `?change=studio` opens the change preview.
 * `useSearchParams` needs a Suspense boundary under the app router.
 */
export default function BillingPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <Suspense fallback={null}>
      <PlanUsageScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
    </Suspense>
  );
}
