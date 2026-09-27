'use client';

import { use } from 'react';
import { SubscriptionScreen } from '../../../../components/screens/SubscriptionScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Subscription** — the billing screen from `38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP` §Billing:
 * view the current plan and request a plan change.
 *
 * A sibling of `billing/` (storage usage), not on the internal rail (`22-SCREEN-BY-SCREEN` §1 fixes
 * that at eight destinations and billing is not among them), so this route names none and adds no nav
 * entry. The screen reads and writes `…/billing/subscription`, both gated on `org.manage`, so a
 * member without it sees the API's refusal rather than a blank page. Requesting a change records an
 * intent (`pending_change`); no payment is executed.
 */
export default function SubscriptionPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <SubscriptionScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
