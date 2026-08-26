'use client';

import { use } from 'react';
import { useRouter } from 'next/navigation';
import { InvitationScreen } from '../../../components/screens/InvitationScreen';

/**
 * **ID-03 Invitation acceptance.**
 *
 * The route takes a token because that is the shape the real screen has: an invitation link
 * carries an opaque token and the screen is reached by following it. As of `TEN-003` the token
 * resolves to a real invitation.
 *
 * The token is handed to the screen and **never rendered**. It is a credential that grants
 * membership in an organization: printing it would put it in the DOM, in any screenshot, and
 * in a `Referer` header on the next outbound link. The screen sends it in a request body, and
 * a test asserts it appears in neither the document nor `window.location` beyond the path the
 * person already followed.
 */
export default function InvitationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const router = useRouter();

  return <InvitationScreen token={token} onAccepted={() => router.push('/organizations')} />;
}
