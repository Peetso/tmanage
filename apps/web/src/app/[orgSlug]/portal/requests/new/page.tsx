'use client';

import { use } from 'react';
import { NewClientRequestScreen } from '../../../../../components/screens/NewClientRequestScreen';
import { FIXTURE_CLIENT_NAME, FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * **CL-09 New request** — the first half of `22-SCREEN-BY-SCREEN` §6's `CL-06`.
 *
 * The screen shows its own confirmation and this route does not navigate, because §6's one
 * bolded requirement is that the confirmation states the date is uncommitted. A route that
 * redirected on success would replace that sentence with a page transition. The confirmation
 * carries its own links onward, so nothing is lost by staying put.
 */
export default function NewClientRequestPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <NewClientRequestScreen
      organizationSlug={orgSlug}
      clientName={FIXTURE_CLIENT_NAME}
      providerName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
