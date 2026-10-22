'use client';

import { use } from 'react';
import { DeliverableDetailScreen } from '../../../../../../components/screens/DeliverableDetailScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../../lib/fixtures';

/** **Team deliverable (BG2, DEL-02)** — versions, upload, and Send for approval. */
export default function ProjectDeliverablePage({
  params,
}: {
  params: Promise<{ orgSlug: string; projectId: string; deliverableId: string }>;
}) {
  const { orgSlug, projectId, deliverableId } = use(params);

  return (
    <DeliverableDetailScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      projectId={projectId}
      deliverableId={deliverableId}
    />
  );
}
