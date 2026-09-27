'use client';

import { use } from 'react';
import { AdminSecurityScreen } from '../../../../components/screens/AdminSecurityScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Security settings** — the Administration security config (ADM, x176).
 *
 * Like `audit` and `billing`, it is not one of the eight internal-rail destinations
 * (`22-SCREEN-BY-SCREEN` §1), so this route names none and adds no nav entry — it is reached directly.
 * The screen reads `GET /v1/organizations/:orgSlug/admin/security`, gated on `org.manage`, so a caller
 * without the capability sees the API's refusal rather than a blank page.
 */
export default function AdminSecurityPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <AdminSecurityScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
