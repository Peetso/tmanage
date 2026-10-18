'use client';

import { use } from 'react';
import { PreferencesScreen } from '../../../components/screens/PreferencesScreen';
import { KeyboardShortcutsScreen } from '../../../components/screens/KeyboardShortcutsScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../lib/fixtures';

/**
 * **Preferences** — the page under the account orb (PREF-01, x182, module 20).
 *
 * Under `[orgSlug]/preferences`: the slug is the claim the API's `TenantContextGuard` resolves
 * against a membership row. The screen reads `GET …/me/preferences` and writes `PUT …/me/preferences`
 * (both behind `work.read`, taking no membership id — the settings are the acting member's own), so a
 * member without the capability sees the API's refusal rather than a blank page.
 *
 * `?section=keyboard` is PREF-05, the keyboard section of the same "YOURS ONLY" column: the
 * shortcut map (x286) that had no route of its own.
 */
export default function PreferencesPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ section?: string | string[] }>;
}) {
  const { orgSlug } = use(params);
  const { section } = use(searchParams);

  if (section === 'keyboard') {
    return (
      <KeyboardShortcutsScreen
        organizationSlug={orgSlug}
        organizationName={FIXTURE_ORGANIZATION_NAME}
      />
    );
  }

  return (
    <PreferencesScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
