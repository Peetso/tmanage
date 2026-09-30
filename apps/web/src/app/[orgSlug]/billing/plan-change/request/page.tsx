'use client';

import { use } from 'react';
import { PlanChangeRequestView } from '../../../../../components/screens/PlanChangeRequestView';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * **Plan-change request** — Billing / module 19 (x284) from `38-…` §Billing and `49-PRICING-…`
 * §plan changes: record an organization's intent to move to another plan, and list/cancel it.
 *
 * A sibling of `billing/plan-change/preview`, not on the internal rail (`22-SCREEN-BY-SCREEN` §1 fixes
 * that at eight destinations and billing is not among them), so this route names none and adds no nav
 * entry. The screen reads `…/billing/plan-change-requests`, gated on `org.manage`, so a member without
 * it sees the API's refusal rather than a blank page. It is a recorded intent; no payment is made.
 */
export default function PlanChangeRequestPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = use(params);

  return (
    <PlanChangeRequestView
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
