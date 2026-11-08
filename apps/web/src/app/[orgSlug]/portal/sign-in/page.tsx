'use client';

import { use } from 'react';
import { PortalSignInRequestScreen } from '../../../../components/screens/portal-sign-in/PortalSignInScreen';

/** 55-14 — a client asks for a one-time sign-in link to this organization's portal. */
export default function PortalSignInPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  return <PortalSignInRequestScreen orgSlug={orgSlug} />;
}
