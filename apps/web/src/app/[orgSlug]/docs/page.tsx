'use client';

import { use } from 'react';
import { useSearchParams } from 'next/navigation';
import { DocsHubScreen } from '../../../components/screens/DocsHubScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../lib/fixtures';

/**
 * **DOC-01 Docs hub.**
 *
 * The project can arrive in the query string, which is how a project screen hands off to its
 * documents: the link carries `?project=`, and the hub opens on it. A project in the URL is a
 * link a colleague can be sent, which is why it lives there rather than in component state alone.
 *
 * The organization name is still a fixture, as the sibling pages note: no endpoint returns the
 * current organization's profile by slug.
 */
export default function DocsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  const search = useSearchParams();
  const project = search.get('project');

  return (
    <DocsHubScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      {...(project === null ? {} : { initialProjectId: project })}
    />
  );
}
