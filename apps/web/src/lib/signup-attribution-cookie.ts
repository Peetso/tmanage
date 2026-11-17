import {
  parseSignupAttribution,
  SIGNUP_ATTRIBUTION_COOKIE,
  SIGNUP_ATTRIBUTION_MAX_AGE_SECONDS,
  signupAttributionCookieValue,
  signupReferrerHost,
} from '@tmanage/domain';
import type { NextRequest, NextResponse } from 'next/server';
import { siteOrigin } from './site-origin';

/**
 * ADTRACK (2026-11-16): a public page reached from an ad (`?utm_source=facebook&...`) keeps the
 * valid `utm_*` values in a first-party cookie for 30 days, so the sign-up endpoint can store
 * where the account came from. httpOnly (no script reads it), `Secure`, `SameSite=Lax` (sent on
 * the same-site sign-up request), whole-site path. Invalid values are dropped by the shared
 * schema; a visit without any valid value leaves an earlier cookie as it was. No third-party
 * script, nothing sent anywhere: the API reads it back from its own request and validates again.
 *
 * SEOD (B11, 2026-11-17): the referring site's HOST (`chatgpt.com`, `google.com`) rides along,
 * never its address or query. A landing with `utm_*` values writes them with the host; a plain
 * referral (a host, no `utm_*`) is written only when no earlier cookie exists, so an ad's
 * campaign is not replaced by a later search visit. Our own pages are never a source.
 */
export function rememberSignupAttribution(request: NextRequest, response: NextResponse): void {
  const utm = parseSignupAttribution((key) => request.nextUrl.searchParams.get(key));
  const referrerHost = signupReferrerHost(request.headers.get('referer'), ownHosts(request));
  if (
    utm === undefined &&
    (referrerHost === undefined || request.cookies.has(SIGNUP_ATTRIBUTION_COOKIE))
  ) {
    return;
  }
  const attribution = {
    ...utm,
    ...(referrerHost === undefined ? {} : { referrer_host: referrerHost }),
  };
  response.cookies.set(SIGNUP_ATTRIBUTION_COOKIE, signupAttributionCookieValue(attribution), {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SIGNUP_ATTRIBUTION_MAX_AGE_SECONDS,
  });
}

/** The hosts that are this site: the one asked for and the configured public origin's. */
function ownHosts(request: NextRequest): readonly string[] {
  try {
    return [request.nextUrl.hostname, new URL(siteOrigin()).hostname];
  } catch {
    return [request.nextUrl.hostname];
  }
}
