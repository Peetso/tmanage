'use client';

import { use } from 'react';
import { HomeWidgetPrefsScreen } from '../../../../components/screens/HomeWidgetPrefsScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Edit widgets** — the person's own My Day layout (spec MYDAY-V4 §5, "Edit widgets" at the end of
 * the main column): reorder the parts inside each column and hide the ones they do not want. The
 * screen and its `home_widget_prefs` read and write were built before; this page gives them a route.
 */
export default function HomeWidgetsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <HomeWidgetPrefsScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
