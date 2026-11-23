'use client';

import { use } from 'react';
import { useSearchParams } from 'next/navigation';
import { WorkListScreen } from '../../../components/screens/WorkListScreen';
import { parseWorkListParams } from '../../../components/work/list/work-list-model';
import { FIXTURE_ORGANIZATION_NAME } from '../../../lib/fixtures';

/**
 * **TM-10 Works list and board** (Work area v2, W-WEB-2).
 *
 * Every filter can arrive in the query string (`?project=`, `?state=`, `?stage=`, `?doer=`,
 * `?team=`, `?due=`), which is how the project overview's "Update work" action hands off and how
 * a filtered list becomes a link somebody can send to a colleague (I-1).
 *
 * The organization name is still a fixture: no endpoint returns the current organization's
 * profile by slug. `ID-04` fetches the list of them, and picking one out of that list here
 * would be a second request for a string.
 */
export default function WorkPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  const search = useSearchParams();
  // R38 G5-views: with no `?view=`, the screen opens the view last chosen on this page.
  const viewParam = search.get('view');
  const view = viewParam === 'board' || viewParam === 'list' ? viewParam : undefined;

  return (
    <WorkListScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      initialFilters={parseWorkListParams(search)}
      {...(view === undefined ? {} : { initialView: view })}
    />
  );
}
