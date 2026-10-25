'use client';

import { useRouter } from 'next/navigation';
import { SignInScreen } from '../../components/screens/SignInScreen';
import { safeReturnPath } from '../../lib/sign-in-return';

/**
 * **ID-01 Sign in.** The screen itself is in `components/screens` so a test can mount it.
 *
 * `?next=` is honoured only for an invitation path (`safeReturnPath`), so somebody sent here
 * from an invitation link lands back on it after signing in (ACC-01).
 *
 * A person who is already signed in is sent into the app (`signedInDestination`) — replaced,
 * not pushed, so Back does not return to a sign-in form they do not need.
 */
export default function SignInPage() {
  const router = useRouter();
  return (
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
  );
}
