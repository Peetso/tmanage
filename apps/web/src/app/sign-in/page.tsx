import { requestSessionHint } from '../../lib/workspace-gate-request';
import { SignInPageClient } from './SignInPageClient';

/**
 * **ID-01 Sign in.** Rendered per request (`layout.tsx`): the server's reading of the session
 * cookie decides the first HTML — "Checking your sign-in…" when this browser may hold a session,
 * the form when it cannot (AUTHSTATE, `EntrySessionGate`).
 */
export default async function SignInPage() {
  return <SignInPageClient sessionHint={await requestSessionHint()} />;
}
