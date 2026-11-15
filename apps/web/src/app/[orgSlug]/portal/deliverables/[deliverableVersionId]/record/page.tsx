'use client';

import { use } from 'react';
import { PortalApprovalCertificate } from '../../../../../../components/screens/approvals/ApprovalCertificate';

/** **52-19 Approval record** — the client's printable record of their own decision on a version. */
export default function PortalApprovalRecordPage({
  params,
}: {
  params: Promise<{ orgSlug: string; deliverableVersionId: string }>;
}) {
  const { orgSlug, deliverableVersionId } = use(params);

  return (
    <PortalApprovalCertificate
      organizationSlug={orgSlug}
      deliverableVersionId={deliverableVersionId}
    />
  );
}
