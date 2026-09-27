'use client';

import { use } from 'react';
import { PreferencesScreen } from '../../../components/screens/PreferencesScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../lib/fixtures';

/**
 * **Preferences** — the appearance & accessibility surface (x182, module 20).
 *
 * Under `[orgSlug]/preferences`: the slug is the claim the API's `TenantContextGuard` resolves
 * against a membership row. The screen reads `GET …/me/preferences` and writes `PUT …/me/preferences`
 * (both behind `work.read`, taking no membership id — the settings are the acting member's own), so a
 * member without the capability sees the API's refusal rather than a blank page.
 */
export default function PreferencesPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <PreferencesScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
