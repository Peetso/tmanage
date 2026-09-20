'use client';

import { use } from 'react';
import { MyDayScreen } from '../../../components/screens/MyDayScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../lib/fixtures';

/**
 * **Home** — the first destination on the internal rail (`22-SCREEN-BY-SCREEN` §1), and the
 * target of the rail's brand link (`AppShell` points it at `/{slug}/home`).
 *
 * HOME-03's first vertical slice: the ranked "what needs you today" My Day view, its Personal-
 * work section reading the acting user's own open work across every project. This replaces the
 * `HOME-001` `PlannedInternalScreen` stub; the hero/Pulse/Focus (HOME-01), Waiting (HOME-04) and
 * Saved/pinned (HOME-05) are the follow-up slices the section is built to sit alongside.
 */
export default function HomePage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return <MyDayScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />;
}
