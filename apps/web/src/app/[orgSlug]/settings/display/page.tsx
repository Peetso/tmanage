'use client';

import { use } from 'react';
import { DisplayPreferencesView } from '../../../../components/screens/DisplayPreferencesView';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Display preferences hub (module 20 Preferences & accessibility, PREF-DISPLAY, x285).**
 *
 * The member's own theme / density / locale / timezone / date-format controls, at
 * `/{orgSlug}/settings/display`. The organization name is still a fixture, the reason every sibling
 * screen gives: no endpoint returns the current organization's profile by slug.
 */
export default function DisplayPreferencesPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = use(params);
  return (
    <DisplayPreferencesView
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
