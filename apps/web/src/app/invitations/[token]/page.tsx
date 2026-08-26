import { InvitationScreen } from '../../../components/screens/InvitationScreen';
import { FIXTURE_INVITATION } from '../../../lib/fixtures';

/**
 * **ID-03 Invitation acceptance.**
 *
 * The route takes a token because that is the shape the real screen has: an invitation link
 * carries an opaque token, and the screen is reached by following it. Nothing resolves the
 * token — invitations are `TEN-003` — so the fixture is rendered whatever the token says,
 * and the screen states that plainly.
 *
 * The token is deliberately not echoed anywhere in the page. An invitation token is a
 * credential: printing it into the document would put it in the DOM, in any screenshot, and
 * in a `Referer` header on the next outbound link.
 */
export default async function InvitationPage({ params }: { params: Promise<{ token: string }> }) {
  await params;
  return <InvitationScreen invitation={FIXTURE_INVITATION} />;
}
