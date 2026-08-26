'use client';

import { useRouter } from 'next/navigation';
import { SignInScreen } from '../../components/screens/SignInScreen';

/** **ID-01 Sign in.** The screen itself is in `components/screens` so a test can mount it. */
export default function SignInPage() {
  const router = useRouter();
  return <SignInScreen onSignedIn={() => router.push('/organizations')} />;
}
