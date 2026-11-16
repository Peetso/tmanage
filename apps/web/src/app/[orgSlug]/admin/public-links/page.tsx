'use client';

import { use } from 'react';
import { AdminPublicLinksScreen } from '../../../../components/screens/AdminPublicLinksScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * 56-07p · **Public links** — every link the workspace issued that opens without signing in.
 * Reads `GET /v1/organizations/:orgSlug/public-links/manage` (`org.security.manage`). The
 * organization name is a fixture the shell replaces with the live name, as on the other pages.
 */
export default function AdminPublicLinksPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  return (
    <AdminPublicLinksScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
