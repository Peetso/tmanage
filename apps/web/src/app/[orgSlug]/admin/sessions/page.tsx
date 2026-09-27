'use client';

import { use } from 'react';
import { AdminSessionsScreen } from '../../../../components/screens/AdminSessionsScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Active sessions** — the Administration session viewer + revocation (ADM, x223).
 *
 * Like `audit`, it is not one of the eight internal-rail destinations (`22-SCREEN-BY-SCREEN`
 * §1), so this route names none and adds no nav entry — it is reached directly. The screen reads
 * `GET /v1/organizations/:orgSlug/admin/sessions` and posts revocations, both gated on
 * `org.manage`, so a caller without the capability sees the API's refusal rather than a blank
 * page. The organization name is still a fixture, for `AdminRolesPage`'s reason: no endpoint
 * returns the current organization's profile by slug.
 */
export default function AdminSessionsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <AdminSessionsScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
