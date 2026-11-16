'use client';

import { use } from 'react';
import { ConfirmEmailScreen } from '../../../components/screens/ConfirmEmailScreen';

/**
 * **Confirm your e-mail — the link from the confirmation mail** (VERIFYMAIL). The token comes from
 * the path and goes into a request body only after the person clicks; it is never rendered.
 */
export default function ConfirmEmailPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  return <ConfirmEmailScreen token={token} />;
}
