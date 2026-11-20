'use client';

import { useRouter } from 'next/navigation';
import { SignInScreen } from '../../components/screens/SignInScreen';
import { EntrySessionGate } from '../../components/session/EntrySessionGate';
import { LanguageSwitch } from '../../components/website/WebFooter';
import { afterSignInPath } from '../../lib/sign-in-return';
import './sign-in-lang.css';

/**
 * **ID-01 Sign in** — the client half of `page.tsx`. The screen itself is in `components/screens`
 * so a test can mount it.
 *
 * `?next=` is honoured only for an allowed return path (`safeReturnPath`): an invitation, the
 * AI-app consent page, an AI approval, a Platform admin page (ACC-01, S9, S10, PLATFORMFIX).
 *
 * AUTHSTATE: a visitor who is already signed in is shown "You're signed in as <email>" with
 * Continue and Sign out (`EntrySessionGate`), never the empty form; an API that does not answer
 * is shown as "retrying", never as a sign-out.
 *
 * A5: the website's language switch is the card's last row, so a visitor can change the
 * language before signing in; on `/sign-in` ↔ `/ar/sign-in` it loads the other twin.
 */
export function SignInPageClient({ sessionHint }: { sessionHint: boolean }) {
  const router = useRouter();
  return (
    <EntrySessionGate sessionHint={sessionHint}>
      <SignInScreen
        language={<LanguageSwitch />}
        onSignedIn={() => {
          const search = typeof window === 'undefined' ? '' : window.location.search;
          const next = new URLSearchParams(search).get('next');
          router.push(afterSignInPath(next, search));
        }}
      />
    </EntrySessionGate>
  );
}
