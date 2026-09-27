'use client';

import { use } from 'react';
import { PlanChangePreviewScreen } from '../../../../../components/screens/PlanChangePreviewScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * **Plan-change preview** — Billing / module 19 (x198) from `38-…` §Billing: estimate what changing
 * plan would cost before requesting the change x177 records.
 *
 * A sibling of `billing/subscription`, not on the internal rail (`22-SCREEN-BY-SCREEN` §1 fixes that
 * at eight destinations and billing is not among them), so this route names none and adds no nav
 * entry. The screen reads `…/billing/plan-change/preview`, gated on `org.manage`, so a member without
 * it sees the API's refusal rather than a blank page. It is a read-only estimate; no payment is made.
 */
export default function PlanChangePreviewPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = use(params);

  return (
    <PlanChangePreviewScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
