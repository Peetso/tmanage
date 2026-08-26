'use client';

import { useRouter } from 'next/navigation';
import { SessionsScreen } from '../../components/screens/SessionsScreen';

/** **ID-05 Session and recovery** — the sessions half. Its data is real. */
export default function SessionsPage() {
  const router = useRouter();
  return <SessionsScreen onSignedOut={() => router.push('/sign-in')} />;
}
