'use client';

import { use } from 'react';
import { BillingContactsScreen } from '../../../../components/screens/BillingContactsScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Billing contacts (Billing module 19, x199).**
 *
 * The contacts screen. Not on the internal rail (`22-SCREEN-BY-SCREEN` §1 fixes that at eight
 * destinations and billing is not among them), so this route names no nav entry — the same choice the
 * sibling billing routes made. The screen's reads and writes are gated on `org.manage`, so a member
 * without it sees the API's refusal rather than a blank page. The organization name is a fixture, for
 * the same reason the sibling screens use one: no endpoint returns the organization's profile by slug.
 */
export default function BillingContactsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <BillingContactsScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
