'use client';

import { use, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { ConsentScreen } from '../../../components/screens/ConsentScreen';
import { consentParamsFrom } from '../../../lib/api/oauth-consent';

/**
 * **S0-1 Consent** — where `/oauth/authorize` sends a validated AI-app connection request
 * (MCP connector S9). The OAuth parameters arrive in the query string and are handed to the
 * screen, which re-validates them through the API before showing anything.
 *
 * A signed-out person is sent to sign-in with this exact page as `next`, and comes back to it
 * afterwards (`safeReturnPath` allows only `/connect/authorize?…`). The page cannot be framed:
 * `next.config.ts` sends `frame-ancestors 'none'` and `X-Frame-Options: DENY` for `/connect/*`.
 */
export default function ConnectAuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = use(searchParams);
  const router = useRouter();

  const params = useMemo(() => {
    const search = new URLSearchParams();
    for (const [name, value] of Object.entries(raw)) {
      if (typeof value === 'string') search.set(name, value);
    }
    return consentParamsFrom(search);
  }, [raw]);

  const toSignIn = useCallback(() => {
    const here = `${window.location.pathname}${window.location.search}`;
    router.replace(`/sign-in?next=${encodeURIComponent(here)}`);
  }, [router]);

  return <ConsentScreen params={params} onSignInRequired={toSignIn} />;
}
