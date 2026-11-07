'use client';

import { use } from 'react';
import { PublicQuoteScreen } from '../../../components/screens/quotes/PublicQuoteScreen';

/**
 * A12 — the client's page for a sent quote. The quote editor hands out `/q/<token>` after
 * `POST …/quotes/:id/send`; no session is needed and nothing here is tenant-scoped.
 */
export default function PublicQuotePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  return <PublicQuoteScreen token={token} />;
}
