import type { ReactNode } from 'react';
import { PlatformAccessGate } from '../../components/platform/PlatformAccessGate';
import { SignedInGate } from '../../components/session/SignedInGate';

/**
 * FIX6 locale flash: rendered per request, so the first HTML is in the member's saved language
 * (`lib/i18n/server-html-attributes.ts`) rather than the English prerender.
 */
export const dynamic = 'force-dynamic';

/**
 * AUTHSTATE: no Platform admin chrome renders before the shared session check has confirmed the
 * session (`SignedInGate`) and the API has said this person may see Platform admin
 * (`PlatformAccessGate`, the same `GET /v1/platform/me` the pages' `PlatformGate` reads).
 */
export default function PlatformLayout({ children }: { children: ReactNode }) {
  return (
    <SignedInGate>
      <PlatformAccessGate>{children}</PlatformAccessGate>
    </SignedInGate>
  );
}
