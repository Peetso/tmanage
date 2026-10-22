'use client';

import { use } from 'react';
import { AiApproveScreen } from '../../../../../components/screens/AiApproveScreen';

/**
 * **S0-3 Approve action** (MCP connector S10) — `/<org>/ai/approve/<id>`.
 *
 * The link an AI app hands the member when it asks for a confirm-class action. Served with
 * `frame-ancestors 'none'` (see `next.config.ts`) so it cannot be framed into a clickjack.
 */
export default function AiApprovePage({
  params,
}: {
  params: Promise<{ orgSlug: string; id: string }>;
}) {
  const { orgSlug, id } = use(params);
  return <AiApproveScreen orgSlug={orgSlug} approvalId={id} />;
}
