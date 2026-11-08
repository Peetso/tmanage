'use client';

import { use } from 'react';
import { PortalMagicLinkScreen } from '../../../components/screens/portal-sign-in/PortalSignInScreen';

/**
 * 55-14 — the page a client's sign-in link opens. Opening it signs nobody in (mail scanners
 * fetch links); the "Sign in" click spends the link. `?not-you=1` opens the cancel step.
 */
export default function PortalMagicLinkPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ 'not-you'?: string }>;
}) {
  const { token } = use(params);
  const query = use(searchParams);
  return <PortalMagicLinkScreen token={token} notYou={query['not-you'] === '1'} />;
}
