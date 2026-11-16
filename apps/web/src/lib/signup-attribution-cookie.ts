import {
  parseSignupAttribution,
  SIGNUP_ATTRIBUTION_COOKIE,
  SIGNUP_ATTRIBUTION_MAX_AGE_SECONDS,
  signupAttributionCookieValue,
} from '@tmanage/domain';
import type { NextRequest, NextResponse } from 'next/server';

/**
 * ADTRACK (2026-11-16): a public page reached from an ad (`?utm_source=facebook&...`) keeps the
 * valid `utm_*` values in a first-party cookie for 30 days, so the sign-up endpoint can store
 * where the account came from. httpOnly (no script reads it), `Secure`, `SameSite=Lax` (sent on
 * the same-site sign-up request), whole-site path. Invalid values are dropped by the shared
 * schema; a visit without any valid value leaves an earlier cookie as it was. No third-party
 * script, nothing sent anywhere: the API reads it back from its own request and validates again.
 */
export function rememberSignupAttribution(request: NextRequest, response: NextResponse): void {
  const attribution = parseSignupAttribution((key) => request.nextUrl.searchParams.get(key));
  if (attribution === undefined) return;
  response.cookies.set(SIGNUP_ATTRIBUTION_COOKIE, signupAttributionCookieValue(attribution), {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SIGNUP_ATTRIBUTION_MAX_AGE_SECONDS,
  });
}
