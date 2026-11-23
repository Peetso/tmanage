'use client';

import { use } from 'react';
import { useSearchParams } from 'next/navigation';
import { StagesSettingsScreen } from '../../../../components/work/stages/StagesSettingsScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Settings → Stages (W-WEB-5)** at `/{orgSlug}/settings/stages`: the workspace's stage sets.
 * `?new=1` opens New stage set (the work page's set picker links here); `?set=<id>` opens one set
 * (a project's "Edit this stage set"). The organization name is still a fixture, the reason every
 * sibling settings screen gives: no endpoint returns the current organization's profile by slug.
 */
export default function StagesSettingsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  const search = useSearchParams();
  const setId = search.get('set');
  return (
    <StagesSettingsScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      startNew={search.get('new') === '1'}
      {...(setId ? { setId } : {})}
    />
  );
}
