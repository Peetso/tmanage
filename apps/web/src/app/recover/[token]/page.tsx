'use client';

import { use } from 'react';
import { RecoveryScreen } from '../../../components/screens/RecoveryScreen';

/**
 * **ID-05 Recovery — the link from the reset email** (ACC-02).
 *
 * The token comes from the path, as an emailed link puts it, and goes straight into a request
 * body; it is never rendered. The screen starts in the "choose a new password" state and can
 * only reach "completed" or "expired" from the API's answer — no URL can claim either (D15).
 */
export default function RecoverWithLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  return <RecoveryScreen token={token} />;
}
