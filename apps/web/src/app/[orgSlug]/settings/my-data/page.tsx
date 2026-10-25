'use client';

import { use } from 'react';
import { MyDataScreen } from '../../../../components/screens/MyDataScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **My data** (D5, Figma F5 phone) — the person's own data export and account deletion, at
 * `/{orgSlug}/settings/my-data`. The organization name shown before the read answers is the fixture
 * every sibling settings screen uses; the page then shows the name the API returns.
 */
export default function MyDataPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  return <MyDataScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />;
}
