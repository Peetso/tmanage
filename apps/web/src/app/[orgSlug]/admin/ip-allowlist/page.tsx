'use client';

import { use } from 'react';
import { IpAllowlistView } from '../../../../components/screens/IpAllowlistView';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Organization IP allowlist** — the Administration security config (ADM, x277).
 *
 * Like `security` and `audit`, it is not one of the eight internal-rail destinations
 * (`22-SCREEN-BY-SCREEN` §1), so this route names none and adds no nav entry — it is reached directly.
 * The screen reads `GET /v1/organizations/:orgSlug/admin/ip-allowlist`, gated on `org.security.manage`,
 * so a caller without the capability sees the API's refusal rather than a blank page. The organization
 * name is a fixture, the same choice the sibling admin routes make — no endpoint returns the
 * organization's profile by slug.
 */
export default function AdminIpAllowlistPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <IpAllowlistView organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
