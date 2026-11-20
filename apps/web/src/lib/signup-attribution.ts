import {
  LEGACY_SIGNUP_ATTRIBUTION_COOKIE,
  parseSignupAttribution,
  SIGNUP_ATTRIBUTION_KEYS,
  type SignupAttribution,
} from '@tmanage/domain';
import type { NextRequest, NextResponse } from 'next/server';
import { referralCodeFromQuery } from './api/referrals';

/**
 * ADTRACK without a cookie (NOCOOKIE, 2026-11-20, manager decision).
 *
 * Where a sign-up came from travels in the address only. A marketing page copies the valid
 * `utm_*` values and a well-formed `ref` invite code of its own address (`location.search`) onto
 * its sign-up links (`components/website/SignupLinkCarrier.tsx`); the sign-up form reads them from
 * its own address and sends the `utm_*` values with the sign-up request (`attribution`). No
 * cookie, `localStorage` or `sessionStorage` is used. ePrivacy Directive art. 5(3): storing an
 * attribution value on the visitor's device is not strictly necessary for the service they asked
 * for (Art. 29 WP Opinion 04/2012, WP194 §4), so it would need consent; the address needs none.
 *
 * The retired `tm_signup_source` cookie is never read. A browser that still sends it gets it
 * expired once ({@link forgetLegacySignupAttribution}).
 */

/** The sign-up pages a marketing link can lead to, English and Arabic. */
export const SIGN_UP_PATHS: readonly string[] = ['/sign-up', '/ar/sign-up'];

/** The invite-code parameter the sign-up page already reads (REFERRAL, 57-08). */
const REFERRAL_PARAM = 'ref';

/** Expires the retired attribution cookie (Max-Age=0) on a response to a browser that sent it. */
export function forgetLegacySignupAttribution(request: NextRequest, response: NextResponse): void {
  if (!request.cookies.has(LEGACY_SIGNUP_ATTRIBUTION_COOKIE)) return;
  // The same name, path and flags it was written with, so the browser replaces and drops it.
  response.cookies.set(LEGACY_SIGNUP_ATTRIBUTION_COOKIE, '', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}

/** The valid `utm_*` values in a query string, for the sign-up request. */
export function signupAttributionFromSearch(search: string): SignupAttribution | undefined {
  const params = new URLSearchParams(search);
  return parseSignupAttribution((key) => params.get(key));
}

/** The parameters a sign-up link carries on: the valid `utm_*` values and a well-formed `ref`. */
export function carriedSignupParams(search: string): readonly (readonly [string, string])[] {
  const attribution = signupAttributionFromSearch(search) ?? {};
  const carried: [string, string][] = SIGNUP_ATTRIBUTION_KEYS.flatMap((key) => {
    const value = attribution[key];
    return value === undefined ? [] : [[key, value] as [string, string]];
  });
  const referral = referralCodeFromQuery(new URLSearchParams(search).get(REFERRAL_PARAM));
  if (referral !== null) carried.push([REFERRAL_PARAM, referral]);
  return carried;
}

/**
 * `href` with the carried parameters added, when it is a same-origin link to a sign-up page and
 * at least one parameter is new; otherwise `undefined` (leave the link as it is). A parameter the
 * link already has wins over the carried one.
 */
export function withCarriedSignupParams(
  href: string,
  carried: readonly (readonly [string, string])[],
  origin: string,
): string | undefined {
  if (carried.length === 0 || href === '') return undefined;
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return undefined;
  }
  if (url.origin !== origin || !SIGN_UP_PATHS.includes(url.pathname)) return undefined;
  let changed = false;
  for (const [key, value] of carried) {
    if (url.searchParams.has(key)) continue;
    url.searchParams.set(key, value);
    changed = true;
  }
  return changed ? `${url.pathname}${url.search}${url.hash}` : undefined;
}
