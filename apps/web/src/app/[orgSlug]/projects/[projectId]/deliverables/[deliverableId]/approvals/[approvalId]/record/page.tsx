'use client';

import { use } from 'react';
import { StaffApprovalCertificate } from '../../../../../../../../../components/screens/approvals/ApprovalCertificate';

/** **52-19 Approval record** — the printable record of one approval, for the team. */
export default function DeliverableApprovalRecordPage({
  params,
}: {
  params: Promise<{
    orgSlug: string;
    projectId: string;
    deliverableId: string;
    approvalId: string;
  }>;
}) {
  const { orgSlug, projectId, deliverableId, approvalId } = use(params);

  return (
    <StaffApprovalCertificate
      organizationSlug={orgSlug}
      projectId={projectId}
      deliverableId={deliverableId}
      approvalId={approvalId}
    />
  );
}
