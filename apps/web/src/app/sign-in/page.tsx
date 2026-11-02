'use client';

import { useRouter } from 'next/navigation';
import { SignInScreen } from '../../components/screens/SignInScreen';
import { LanguageSwitch } from '../../components/website/WebFooter';
import { safeReturnPath } from '../../lib/sign-in-return';
import './sign-in-lang.css';

/**
 * **ID-01 Sign in.** The screen itself is in `components/screens` so a test can mount it.
 *
 * `?next=` is honoured only for an invitation path (`safeReturnPath`), so somebody sent here
 * from an invitation link lands back on it after signing in (ACC-01).
 *
 * A person who is already signed in is sent into the app (`signedInDestination`) — replaced,
 * not pushed, so Back does not return to a sign-in form they do not need.
 *
 * A5: the website's English / Arabic switch sits at the top of the page, so a visitor can change
 * the language before signing in; on `/sign-in` ↔ `/ar/sign-in` it loads the other twin.
 */
export default function SignInPage() {
  const router = useRouter();
  return (
    <>
      <div className="tm-sign-in-lang">
        <LanguageSwitch />
      </div>
      <SignInScreen
        onAlreadySignedIn={(destination) => router.replace(destination)}
        onSignedIn={() => {
          const next =
            typeof window === 'undefined'
              ? null
              : new URLSearchParams(window.location.search).get('next');
          router.push(safeReturnPath(next));
        }}
      />
    </>
  );
}
