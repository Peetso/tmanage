'use client';

import { use } from 'react';
import { useSearchParams } from 'next/navigation';
import { WorkListScreen } from '../../../components/screens/WorkListScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../lib/fixtures';

/**
 * **TM-10 Work list.**
 *
 * The project filter can arrive in the query string, which is how the project overview's
 * "Update work" action hands off: the link carries `?project=`, and the list opens filtered to
 * it. A filter in the URL is a link somebody can send to a colleague, which is the whole
 * reason it lives there rather than in component state alone.
 *
 * The organization name is still a fixture: no endpoint returns the current organization's
 * profile by slug. `ID-04` fetches the list of them, and picking one out of that list here
 * would be a second request for a string.
 */
export default function WorkPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  const search = useSearchParams();
  const project = search.get('project');

  return (
    <WorkListScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      {...(project === null ? {} : { initialProjectId: project })}
    />
  );
}
