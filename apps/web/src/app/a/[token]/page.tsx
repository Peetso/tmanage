'use client';

import { use } from 'react';
import { ExternalApproverScreen } from '../../../components/screens/approvals/ExternalApproverScreen';

/**
 * 52-18 — the outside approver's page. A member sends a deliverable version for approval to an
 * e-mail; the mail carries `/a/<token>`. No session is needed and nothing here is tenant-scoped.
 */
export default function ApproverLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  return <ExternalApproverScreen token={token} />;
}
