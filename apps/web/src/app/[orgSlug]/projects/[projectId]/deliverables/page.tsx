'use client';

import { use } from 'react';
import { DeliverablesScreen } from '../../../../../components/screens/DeliverablesScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/** **Team deliverables (BG2, DEL-01)** — one project's deliverables and their review state. */
export default function ProjectDeliverablesPage({
  params,
}: {
  params: Promise<{ orgSlug: string; projectId: string }>;
}) {
  const { orgSlug, projectId } = use(params);

  return (
    <DeliverablesScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      projectId={projectId}
    />
  );
}
