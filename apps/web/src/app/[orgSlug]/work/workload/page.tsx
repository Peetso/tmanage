'use client';

import { use } from 'react';
import { useSearchParams } from 'next/navigation';
import { WorkWorkloadScreen } from '../../../../components/screens/WorkWorkloadScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **WK-06 Work workload.**
 *
 * The project can arrive in the query string, which is how a project screen hands off to its
 * workload: the link carries `?project=`, and the workload opens on it. A project in the URL is a
 * link a colleague can be sent, which is why it lives there rather than in component state alone.
 *
 * The organization name is still a fixture, for `WorkTimelinePage`'s reason: no endpoint returns
 * the current organization's profile by slug.
 */
export default function WorkWorkloadPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  const search = useSearchParams();
  const project = search.get('project');

  return (
    <WorkWorkloadScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      {...(project === null ? {} : { initialProjectId: project })}
    />
  );
}
