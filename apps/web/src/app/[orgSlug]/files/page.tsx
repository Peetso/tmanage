'use client';

import { use } from 'react';
import { useSearchParams } from 'next/navigation';
import { FilesHubScreen } from '../../../components/screens/FilesHubScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../lib/fixtures';

/**
 * **FIL-01 Files hub (FIX3 item 11).** `?project=` opens it on one project, the way a project
 * screen hands off; `?client=` on the projects shared with one client company (D6, the client
 * page's Files tab); without either, every project the person can read.
 */
export default function FilesPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  const search = useSearchParams();
  const project = search.get('project');
  const client = search.get('client');

  return (
    <FilesHubScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      {...(project === null ? {} : { initialProjectId: project })}
      {...(client === null ? {} : { clientOrganizationId: client })}
    />
  );
}
