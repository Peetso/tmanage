'use client';

import { use } from 'react';
import { UnsubscribeScreen } from '../../../components/screens/UnsubscribeScreen';

/**
 * **Unsubscribe from optional e-mails — the link in every mail's footer** (PERSONMAIL, ADR-0013).
 * The API's GET sends a browser here with a verified token; the page asks for one click before it
 * acts, so a link scanner that opens the URL unsubscribes nobody. The token is never rendered.
 */
export default function UnsubscribePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  return <UnsubscribeScreen token={token} />;
}
