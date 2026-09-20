'use client';

import { use } from 'react';
import { ClientApprovalScreen } from '../../../../../components/screens/ClientApprovalScreen';
import { FIXTURE_CLIENT_NAME, FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * The client deep link — FR-05's "reviewer/client opens the governed/published version and
 * decides". The version id in the path is the governed version the projection was published for;
 * `ClientApprovalScreen` reads the allowlisted projection through `client_projection.read` and
 * posts the decision through the client decide route, both addressed by this id.
 */
export default function PortalDeliverableDecisionPage({
  params,
}: {
  params: Promise<{ orgSlug: string; deliverableVersionId: string }>;
}) {
  const { orgSlug, deliverableVersionId } = use(params);

  return (
    <ClientApprovalScreen
      organizationSlug={orgSlug}
      clientName={FIXTURE_CLIENT_NAME}
      providerName={FIXTURE_ORGANIZATION_NAME}
      deliverableVersionId={deliverableVersionId}
    />
  );
}
