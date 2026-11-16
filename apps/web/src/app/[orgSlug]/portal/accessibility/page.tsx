'use client';

import { use } from 'react';
import { PortalAccessibilityScreen } from '../../../../components/screens/PortalAccessibilityScreen';
import { FIXTURE_CLIENT_NAME, FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Display and accessibility** — the client's own text size, contrast and motion (PORTALA11Y).
 * The names are the portal's usual fallbacks; the shell replaces them with the real ones.
 */
export default function PortalAccessibilityPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = use(params);

  return (
    <PortalAccessibilityScreen
      organizationSlug={orgSlug}
      clientName={FIXTURE_CLIENT_NAME}
      providerName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
